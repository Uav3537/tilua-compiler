/**
 * The runtime behind `console:log`, `console:error` and `console:warn`.
 *
 * Written as Luau source rather than built as a tree: it is a page of ordinary
 * code with no compile-time decisions in it, and reading it as code is the
 * point — this is what the author will see in a stack trace.
 *
 * Three things make it more than a `print` wrapper:
 *
 *  - A table is expanded, the way a browser console expands one, instead of
 *    printing as `table: 0x55f3a0`. An address tells the reader nothing about
 *    the value they are trying to look at.
 *  - A function prints as its inferred type and the code it was written as.
 *    Neither of those exists at runtime, so the compiler passes them in: see
 *    `consoleMeta` in lower.ts.
 *  - `error` and `warn` report positions in the project's files. A bundle is
 *    one Luau file, so Luau's own line numbers name a file nobody wrote; the
 *    line map built in linemap.ts is what turns them back. And neither raises
 *    on the calling thread — they hand the error to `task.spawn`, so logging a
 *    problem never becomes the problem.
 *
 * `__NAME__` is the local the compiler gives this, and `__LINES__` the
 * expression holding the bundle's line map (or `nil` outside a bundle).
 */
export const CONSOLE_RUNTIME = `
local __NAME__ = (function()
    local console = {}
    local MAX_DEPTH = 4
    local ESCAPES = { ["\\n"] = "\\\\n", ["\\r"] = "\\\\r", ["\\t"] = "\\\\t", ["\\""] = "\\\\\\"", ["\\\\"] = "\\\\\\\\" }

    local function quote(text)
        return '"' .. text:gsub('[%c"\\\\]', function(c) return ESCAPES[c] or ("\\\\%d"):format(c:byte()) end) .. '"'
    end

    -- A table with 1..n and nothing else prints as a list, as it was written.
    local function isArray(value)
        local count = 0
        for key in pairs(value) do
            if type(key) ~= "number" then return false end
            count = count + 1
        end
        return count == #value
    end

    local function isIdentifier(key)
        return type(key) == "string" and key:match("^[A-Za-z_][A-Za-z0-9_]*$") ~= nil
    end

    local render

    local function renderTable(value, meta, seen, depth, indent)
        if seen[value] then return "<cycle>" end
        if depth > MAX_DEPTH then return "..." end
        seen[value] = true
        local inner = indent .. "  "
        local parts = {}
        if isArray(value) then
            for i = 1, #value do
                parts[#parts + 1] = inner .. render(value[i], nil, seen, depth + 1, inner)
            end
        else
            local keys = {}
            for key in pairs(value) do keys[#keys + 1] = key end
            table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
            for _, key in ipairs(keys) do
                local name = isIdentifier(key) and key or ("[" .. render(key, nil, seen, depth + 1, inner) .. "]")
                parts[#parts + 1] = inner .. name .. " = " .. render(value[key], nil, seen, depth + 1, inner)
            end
        end
        seen[value] = nil
        if #parts == 0 then return "{}" end
        local open = isArray(value) and "[" or "{"
        local close = isArray(value) and "]" or "}"
        return open .. "\\n" .. table.concat(parts, ",\\n") .. "\\n" .. indent .. close
    end

    -- \`meta\` is what the compiler knew about this value and the runtime cannot:
    -- a function's type, and the code it was written as.
    render = function(value, meta, seen, depth, indent)
        local kind = type(value)
        if kind == "string" then return quote(value) end
        if kind == "number" or kind == "boolean" or kind == "nil" then return tostring(value) end
        if kind == "function" then
            if meta == nil then return "function" end
            if meta[2] == nil or meta[2] == "" then return meta[1] end
            return meta[1] .. "  " .. meta[2]
        end
        if kind == "table" then
            local shown = rawget(value, "__tostring") == nil and getmetatable(value)
            -- A value with its own \`__tostring\` (a Roblox Vector3, a class
            -- instance that says how it reads) is trusted to describe itself.
            if shown ~= nil and rawget(shown, "__tostring") ~= nil then return tostring(value) end
            return renderTable(value, meta, seen, depth, indent)
        end
        return tostring(value)
    end

    local function describe(meta, index, value)
        return render(value, meta ~= nil and meta[index] or nil, {}, 1, "")
    end

    local function join(meta, count, ...)
        local parts = {}
        for i = 1, count do
            parts[#parts + 1] = describe(meta, i, (select(i, ...)))
        end
        return table.concat(parts, " ")
    end

    -- A line of the bundle, as the place in the project that wrote it.
    local lines = __LINES__
    local function place(line)
        local origin = lines ~= nil and lines[tonumber(line)]
        if origin == nil then return nil end
        return origin[1] .. ":" .. tostring(origin[2])
    end

    -- Luau names the bundle in every frame; the project's files are what the
    -- reader knows. Frames the map has nothing for are dropped: they are this
    -- runtime's own, and the bundle's.
    local function trace(level)
        local raw = debug.traceback(nil, level)
        local out = {}
        for frame in raw:gmatch("[^\\n]+") do
            local line = frame:match(":(%d+)")
            local at = line ~= nil and place(line) or nil
            if at ~= nil then
                local name = frame:match("function ([%w_.:]+)")
                out[#out + 1] = "    at " .. at .. (name ~= nil and (" (" .. name .. ")") or "")
            end
        end
        return table.concat(out, "\\n")
    end

    -- Never on the caller's thread: reporting a problem must not become one.
    local detach = (task ~= nil and task.spawn) or function(f) return f() end

    local function raise(prefix, meta, count, ...)
        local message = prefix .. join(meta, count, ...)
        local where = trace(3)
        detach(function()
            error(where ~= "" and (message .. "\\n" .. where) or message, 0)
        end)
    end

    function console.log(meta, ...)
        print(join(meta, select("#", ...), ...))
    end

    function console.warn(meta, ...)
        raise("[warn] ", meta, select("#", ...), ...)
    end

    function console.error(meta, ...)
        raise("", meta, select("#", ...), ...)
    end

    return console
end)()
`
