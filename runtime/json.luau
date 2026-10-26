local __NAME__ = {}

-- JSON as tilua's values have it. A table is an array or an object by what
-- the program wrote — `[]` is an array and `{}` an object, empty or not —
-- which a Lua encoder, seeing only a table, cannot tell: `JSONEncode` writes
-- every empty table as `[]`. A table no tilua code made (a Lua library's) is
-- an array when its keys are 1 to its length, as before.
--
-- A table has no key whose value is nil, so two values stand in for what
-- JSON has and Luau does not: `null`, the key sent with no value, and
-- `undefined`, as JavaScript's — left out of an object, and `null` in an
-- array, where leaving it out would move what comes after it.

local NULL = setmetatable({}, { __tostring = function()
	return "null"
end })
local UNDEFINED = setmetatable({}, { __tostring = function()
	return "undefined"
end })

__NAME__.null = NULL
__NAME__.undefined = UNDEFINED

local function isList(t)
	if __ARRAYS__[t] then
		return true
	end
	if next(t) == nil then
		return false
	end
	local count = 0
	for _ in pairs(t) do
		count = count + 1
	end
	return count == #t
end

local function escape(s)
	return (s:gsub('[%c"\\]', function(c)
		if c == '"' then
			return '\\"'
		elseif c == "\\" then
			return "\\\\"
		elseif c == "\n" then
			return "\\n"
		elseif c == "\r" then
			return "\\r"
		elseif c == "\t" then
			return "\\t"
		end
		return string.format("\\u%04x", string.byte(c))
	end))
end

local encode

local function encodeTable(t, seen)
	if seen[t] then
		error("JSON cannot hold a table that holds itself", 0)
	end
	seen[t] = true
	local parts = {}
	if isList(t) then
		for i = 1, #t do
			local item = t[i]
			parts[i] = item == UNDEFINED and "null" or encode(item, seen)
		end
		seen[t] = nil
		return "[" .. table.concat(parts, ",") .. "]"
	end
	-- Written in order, so one value is always one string.
	local keys = {}
	for key, item in pairs(t) do
		local kind = type(key)
		if kind ~= "string" and kind ~= "number" then
			error("JSON keys are strings: cannot write a " .. kind .. " key", 0)
		end
		if item ~= UNDEFINED then
			keys[#keys + 1] = key
		end
	end
	table.sort(keys, function(a, b)
		return tostring(a) < tostring(b)
	end)
	for i, key in ipairs(keys) do
		parts[i] = '"' .. escape(tostring(key)) .. '":' .. encode(t[key], seen)
	end
	seen[t] = nil
	return "{" .. table.concat(parts, ",") .. "}"
end

encode = function(value, seen)
	if value == nil or value == NULL or value == UNDEFINED then
		return "null"
	end
	local kind = type(value)
	if kind == "string" then
		return '"' .. escape(value) .. '"'
	elseif kind == "number" then
		if value ~= value or value == math.huge or value == -math.huge then
			return "null"
		end
		return tostring(value)
	elseif kind == "boolean" then
		return tostring(value)
	elseif kind == "table" then
		return encodeTable(value, seen)
	end
	error("JSON cannot hold a " .. (typeof or type)(value), 0)
end

function __NAME__.encode(value)
	return encode(value, {})
end

-- ============================================================
-- Reading it back
-- ============================================================
--
-- An array comes back an array (`typeof` says so) and an object an object,
-- empty or not. `null` is nil: a key that holds it is not there.

local ESCAPES = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }

local function fail(text, at, what)
	local line = 1
	for _ in text:sub(1, at - 1):gmatch("\n") do
		line = line + 1
	end
	error("Invalid JSON at line " .. line .. ": " .. what, 0)
end

local function skip(text, at)
	return text:find("[^ \t\r\n]", at) or #text + 1
end

local decodeValue

local function decodeString(text, at)
	local parts = {}
	local i = at + 1
	while true do
		local stop = text:find('["\\]', i)
		if stop == nil then
			fail(text, at, "a string that never ends")
		end
		parts[#parts + 1] = text:sub(i, stop - 1)
		if text:sub(stop, stop) == '"' then
			return table.concat(parts), stop + 1
		end
		local c = text:sub(stop + 1, stop + 1)
		if c == "u" then
			local hex = text:sub(stop + 2, stop + 5)
			local code = tonumber(hex, 16)
			if code == nil or #hex < 4 then
				fail(text, stop, "a \\u escape without four hex digits")
			end
			i = stop + 6
			-- A surrogate pair is one character.
			if code >= 0xD800 and code <= 0xDBFF and text:sub(i, i + 1) == "\\u" then
				local low = tonumber(text:sub(i + 2, i + 5), 16)
				if low ~= nil and low >= 0xDC00 and low <= 0xDFFF then
					code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
					i = i + 6
				end
			end
			parts[#parts + 1] = utf8 ~= nil and utf8.char(code) or "?"
		else
			local escaped = ESCAPES[c]
			if escaped == nil then
				fail(text, stop, "an unknown escape '\\" .. c .. "'")
			end
			parts[#parts + 1] = escaped
			i = stop + 2
		end
	end
end

decodeValue = function(text, at)
	at = skip(text, at)
	local c = text:sub(at, at)
	if c == "{" then
		local out = {}
		at = skip(text, at + 1)
		if text:sub(at, at) == "}" then
			return out, at + 1
		end
		while true do
			at = skip(text, at)
			if text:sub(at, at) ~= '"' then
				fail(text, at, "an object key that is not a string")
			end
			local key
			key, at = decodeString(text, at)
			at = skip(text, at)
			if text:sub(at, at) ~= ":" then
				fail(text, at, "a key without ':'")
			end
			local value
			value, at = decodeValue(text, at + 1)
			out[key] = value
			at = skip(text, at)
			local next = text:sub(at, at)
			if next == "}" then
				return out, at + 1
			elseif next ~= "," then
				fail(text, at, "an object without ',' or '}'")
			end
			at = at + 1
		end
	elseif c == "[" then
		local out = __ARRAY__({})
		local n = 0
		at = skip(text, at + 1)
		if text:sub(at, at) == "]" then
			return out, at + 1
		end
		while true do
			local value
			value, at = decodeValue(text, at)
			n = n + 1
			out[n] = value
			at = skip(text, at)
			local next = text:sub(at, at)
			if next == "]" then
				return out, at + 1
			elseif next ~= "," then
				fail(text, at, "an array without ',' or ']'")
			end
			at = at + 1
		end
	elseif c == '"' then
		return decodeString(text, at)
	elseif text:sub(at, at + 3) == "true" then
		return true, at + 4
	elseif text:sub(at, at + 4) == "false" then
		return false, at + 5
	elseif text:sub(at, at + 3) == "null" then
		return nil, at + 4
	end
	local number = text:match("^-?%d+%.?%d*[eE]?[-+]?%d*", at)
	if number == nil or number == "" or tonumber(number) == nil then
		fail(text, at, c == "" and "nothing where a value belongs" or ("an unexpected '" .. c .. "'"))
	end
	return tonumber(number), at + #number
end

function __NAME__.decode(text)
	local value, at = decodeValue(text, 1)
	at = skip(text, at)
	if at <= #text then
		fail(text, at, "more after the value")
	end
	return value
end
