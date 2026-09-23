local __NAME__ = {}

function __NAME__.trim(s)
	return (string.gsub(string.gsub(s, "^%s+", ""), "%s+$", ""))
end

function __NAME__.trimStart(s)
	return (string.gsub(s, "^%s+", ""))
end

function __NAME__.trimEnd(s)
	return (string.gsub(s, "%s+$", ""))
end

function __NAME__.startsWith(s, text)
	return string.sub(s, 1, #text) == text
end

function __NAME__.endsWith(s, text)
	return #text == 0 or string.sub(s, -#text) == text
end

function __NAME__.includes(s, text)
	return string.find(s, text, 1, true) ~= nil
end

function __NAME__.indexOf(s, text, start)
	local at = string.find(s, text, start or 1, true)
	return at
end

function __NAME__.slice(s, start, stop)
	return string.sub(s, start or 1, stop or -1)
end

-- Plain text, not a pattern: `replace("a.b", ".", "-")` changes the dot.
function __NAME__.replace(s, text, replacement)
	if text == "" then
		return replacement .. s
	end
	local at, to = string.find(s, text, 1, true)
	if not at then
		return s
	end
	return string.sub(s, 1, at - 1) .. replacement .. string.sub(s, to + 1)
end

function __NAME__.replaceAll(s, text, replacement)
	if text == "" then
		return s
	end
	local out = {}
	local at = 1
	while true do
		local from, to = string.find(s, text, at, true)
		if not from then
			break
		end
		out[#out + 1] = string.sub(s, at, from - 1)
		out[#out + 1] = replacement
		at = to + 1
	end
	out[#out + 1] = string.sub(s, at)
	return table.concat(out)
end

function __NAME__.padStart(s, length, padding)
	local pad = padding or " "
	if #s >= length or pad == "" then
		return s
	end
	local filler = string.rep(pad, math.ceil((length - #s) / #pad))
	return string.sub(filler, 1, length - #s) .. s
end

function __NAME__.padEnd(s, length, padding)
	local pad = padding or " "
	if #s >= length or pad == "" then
		return s
	end
	local filler = string.rep(pad, math.ceil((length - #s) / #pad))
	return s .. string.sub(filler, 1, length - #s)
end

-- Lua's own, where Lua answers several values and tilua one: the positions
-- and captures as an array, or nil; the new string without the count.
local function values(...)
	if select("#", ...) <= 1 and (...) == nil then
		return nil
	end
	return { ... }
end

function __NAME__.find(s, pattern, init, plain)
	return values(string.find(s, pattern, init, plain))
end

function __NAME__.match(s, pattern, init)
	return values(string.match(s, pattern, init))
end

function __NAME__.gsub(s, pattern, replacement, n)
	return (string.gsub(s, pattern, replacement, n))
end

function __NAME__.byte(s, i, j)
	if j == nil then
		return (string.byte(s, i))
	end
	return { string.byte(s, i, j) }
end

-- An iterator function: each call is one match's captures, as an array.
function __NAME__.gmatch(s, pattern)
	local step = string.gmatch(s, pattern)
	return function()
		return values(step())
	end
end
