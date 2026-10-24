local __NAME__ = {}

-- The globals whose Luau answer is several values, as tilua has them: one
-- value — an array, or an object. The compiler calls these instead of the
-- globals they stand for, and reading one of those globals as a value
-- (`local p = pcall`) gives the function here, so the two never disagree.

-- `pcall`'s `ok, ...` as `{ success, data, error }`. `data` is what the
-- function returned: one value, since a tilua function returns one.
local function result(ok, ...)
	if ok then
		return { success = true, data = (...) }
	end
	return { success = false, error = (...) }
end

function __NAME__.pcall(f, ...)
	return result(pcall(f, ...))
end

function __NAME__.xpcall(f, handler, ...)
	return result(xpcall(f, handler, ...))
end

function __NAME__.resume(co, ...)
	return result(coroutine.resume(co, ...))
end

-- Several values as an array — or nil, when all there was is nil.
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

function __NAME__.modf(x)
	return { math.modf(x) }
end

function __NAME__.frexp(x)
	return { math.frexp(x) }
end

function __NAME__.next(t, key)
	local k, v = next(t, key)
	if k == nil then
		return nil
	end
	return { k, v }
end

function __NAME__.select(n, ...)
	if n == "#" then
		return select("#", ...)
	end
	return { select(n, ...) }
end

function __NAME__.unpack(list, i, j)
	return { (table.unpack or unpack)(list, i or 1, j or #list) }
end

-- `pairs(t)` and `ipairs(t)` as an iteration — `{ step, state, first }`,
-- which a loop walks with. Each step answers one `{ key, value }`, and is
-- handed the one before it.
local function pairsStep(t, previous)
	local k, v = next(t, previous ~= nil and previous[1] or nil)
	if k == nil then
		return nil
	end
	return { k, v }
end

function __NAME__.pairs(t)
	return { pairsStep, t, nil }
end

local function ipairsStep(t, previous)
	local i = (previous ~= nil and previous[1] or 0) + 1
	local v = t[i]
	if v == nil then
		return nil
	end
	return { i, v }
end

function __NAME__.ipairs(t)
	return { ipairsStep, t, nil }
end

-- An iterator function: each call is one match's captures, as an array.
function __NAME__.gmatch(s, pattern)
	local step = string.gmatch(s, pattern)
	return function()
		return values(step())
	end
end

function __NAME__.loadstring(source, chunkname)
	local f, message = loadstring(source, chunkname)
	return { f, message }
end
