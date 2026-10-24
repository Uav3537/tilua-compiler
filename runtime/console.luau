-- The runtime behind `console:log`, `console:warn`, `console:error`, and the
-- `error` a project calls.
--
-- Every entry takes where it was called from as its first argument, written
-- by the compiler at the call, and puts it in front of what it prints, the way
-- a browser console names the line that logged: `[src/shop/buy:12]: ...`. A
-- bundle is one Luau file, so a line Luau reports names a file nobody wrote;
-- this is the place the author can open. `error` puts it inside the message
-- instead, as Lua does: `src/shop/buy.tilua:12: ...`.
--
-- A call to `print` or `warn` needs none of this: the compiler passes the
-- place to the real function as an extra argument. Read as values
-- (`local p = print`) there is no call site to be given, so the `*Value`
-- forms work it out from the stack and the bundle's line map instead.

local __NAME__ = {}

local MAX_DEPTH = 4
local ESCAPES = { ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t", ['"'] = '\\"', ["\\"] = "\\\\" }

local function quote(text)
	return '"' .. text:gsub('[%c"\\]', function(c)
		return ESCAPES[c] or ("\\%d"):format(c:byte())
	end) .. '"'
end

-- A table with 1..n and nothing else prints as a list, as it was written.
local function isArray(value)
	local count = 0
	for key in pairs(value) do
		if type(key) ~= "number" then
			return false
		end
		count = count + 1
	end
	return count == #value
end

local function isIdentifier(key)
	return type(key) == "string" and key:match("^[A-Za-z_][A-Za-z0-9_]*$") ~= nil
end

local render

local function renderTable(value, seen, depth, indent)
	if seen[value] then
		return "<cycle>"
	end
	if depth > MAX_DEPTH then
		return "..."
	end
	seen[value] = true
	local inner = indent .. "  "
	local parts = {}
	local array = isArray(value)
	if array then
		for i = 1, #value do
			parts[#parts + 1] = inner .. render(value[i], nil, seen, depth + 1, inner)
		end
	else
		local keys = {}
		for key in pairs(value) do
			keys[#keys + 1] = key
		end
		table.sort(keys, function(a, b)
			return tostring(a) < tostring(b)
		end)
		for _, key in ipairs(keys) do
			local name = isIdentifier(key) and key or ("[" .. render(key, nil, seen, depth + 1, inner) .. "]")
			parts[#parts + 1] = inner .. name .. " = " .. render(value[key], nil, seen, depth + 1, inner)
		end
	end
	seen[value] = nil
	if #parts == 0 then
		return "{}"
	end
	local open = array and "[" or "{"
	local close = array and "]" or "}"
	return open .. "\n" .. table.concat(parts, ",\n") .. "\n" .. indent .. close
end

-- `meta` is what the compiler knew about this value and the runtime cannot:
-- a function's type, and the code it was written as.
render = function(value, meta, seen, depth, indent)
	local kind = type(value)
	if kind == "string" then
		return quote(value)
	end
	if kind == "number" or kind == "boolean" or kind == "nil" then
		return tostring(value)
	end
	if kind == "function" then
		if meta == nil then
			return "function"
		end
		if meta[2] == nil or meta[2] == "" then
			return meta[1]
		end
		return meta[1] .. "  " .. meta[2]
	end
	if kind == "table" then
		-- A value with its own `__tostring` (a Roblox Vector3, a class
		-- instance that says how it reads) is trusted to describe itself.
		local metatable = getmetatable(value)
		if type(metatable) == "table" and rawget(metatable, "__tostring") ~= nil then
			return tostring(value)
		end
		return renderTable(value, seen, depth, indent)
	end
	return tostring(value)
end

local function join(meta, count, ...)
	local parts = {}
	for i = 1, count do
		parts[#parts + 1] = render((select(i, ...)), meta ~= nil and meta[i] or nil, {}, 1, "")
	end
	return table.concat(parts, " ")
end

local function prefixed(at, text)
	if at == nil then
		return text
	end
	return at .. ": " .. text
end

-- A line of the bundle, as the place in the project that wrote it.
local lines = __LINES__
local function place(line)
	local origin = lines ~= nil and lines[tonumber(line)]
	if not origin then
		return nil
	end
	return origin[1] .. ":" .. tostring(origin[2])
end

-- The place of the function `level` frames above the caller of this, or nil.
local function caller(level)
	local line
	if debug.info ~= nil then
		line = debug.info(level + 1, "l")
	elseif debug.getinfo ~= nil then
		local info = debug.getinfo(level + 1, "l")
		line = info and info.currentline
	end
	if line == nil or line < 0 then
		return nil
	end
	return place(line)
end

-- Luau names the bundle in every frame; the project's files are what the
-- reader knows. Frames the map has nothing for are dropped: they are this
-- runtime's own, and the bundle's.
local function trace(level)
	local out = {}
	for frame in debug.traceback("", level + 1):gmatch("[^\n]+") do
		local line = frame:match(":(%d+)")
		local at = line ~= nil and place(line) or nil
		if at ~= nil then
			local name = frame:match("function ([%w_.:]+)")
			out[#out + 1] = "    at " .. at .. (name ~= nil and (" (" .. name .. ")") or "")
		end
	end
	return table.concat(out, "\n")
end

-- Never on the caller's thread: reporting a problem must not become one.
local detach = (task ~= nil and task.spawn) or function(f)
	local ok, problem = pcall(f)
	if not ok then
		print(problem)
	end
end

-- `tag` is how the line starts, `[src/a:12]:`, passed to `print` and `warn`
-- as an argument of its own so the host joins it the way it joins the rest.
function __NAME__.log(tag, meta, ...)
	print(tag, join(meta, select("#", ...), ...))
end

function __NAME__.warn(tag, meta, ...)
	local text = join(meta, select("#", ...), ...)
	if warn ~= nil then
		warn(tag, text)
	else
		print(tag, "[warn]", text)
	end
end

function __NAME__.error(tag, meta, ...)
	local message = tag .. " " .. join(meta, select("#", ...), ...)
	local where = trace(2)
	detach(function()
		error(where ~= "" and (message .. "\n" .. where) or message, 0)
	end)
end

-- `error(message, level)`, raised for real — `pcall` still catches it — with
-- the position already in the project's files. Level 1, the default, is the
-- call itself, which the compiler wrote down; a higher level is a caller the
-- compiler could not see, so it is read off the stack. A message that is not
-- a string, or level 0, carries no position in Lua either.
function __NAME__.raise(at, message, level)
	if level == nil then
		level = 1
	end
	if type(message) ~= "string" or level == 0 then
		error(message, 0)
	end
	local where = at
	if level > 1 then
		where = caller(level + 1)
	end
	error(prefixed(where, message), 0)
end

function __NAME__.raiseValue(message, level)
	if level == nil then
		level = 1
	end
	if type(message) ~= "string" or level == 0 then
		error(message, 0)
	end
	error(prefixed(caller(level + 1), message), 0)
end
