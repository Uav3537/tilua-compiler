local __NAME__ = {}

-- `known` is the object's keys in the order its type wrote them, handed over
-- by the lowering; `open` says the type also has an indexer, whose keys
-- follow the named ones. With no one order to give (`known` is nil), every
-- key is listed, in the order `pairs` walks them.
local function keysOf(known, open, t)
	local out = {}
	if known == nil then
		for key in pairs(t) do
			out[#out + 1] = key
		end
		return out
	end
	for i = 1, #known do
		out[i] = known[i]
	end
	if open then
		local listed = {}
		for i = 1, #known do
			listed[known[i]] = true
		end
		for key in pairs(t) do
			if not listed[key] then
				out[#out + 1] = key
			end
		end
	end
	return out
end

function __NAME__.keys(known, open, t)
	return keysOf(known, open, t)
end

-- Indexed, not appended: a missing optional member leaves its place `nil`
-- rather than moving everything after it up one.
function __NAME__.values(known, open, t)
	local keys = keysOf(known, open, t)
	local out = {}
	for i = 1, #keys do
		out[i] = t[keys[i]]
	end
	return out
end

function __NAME__.entries(known, open, t)
	local keys = keysOf(known, open, t)
	local out = {}
	for i = 1, #keys do
		out[i] = { keys[i], t[keys[i]] }
	end
	return out
end

-- JavaScript's `Object` functions, as methods of the table they take first.
-- `known` and `open` are handed to every method here; these need neither.

-- The table's own member, not one its metatable's `__index` lends it.
function __NAME__.hasOwn(known, open, t, key)
	return rawget(t, key) ~= nil
end

function __NAME__.hasOwnProperty(known, open, t, key)
	return rawget(t, key) ~= nil
end

-- Each source's members onto `t`, later sources over earlier ones; a `nil`
-- source is skipped, as JavaScript skips `null`.
function __NAME__.assign(known, open, t, ...)
	for i = 1, select("#", ...) do
		local source = select(i, ...)
		if source ~= nil then
			for key, value in pairs(source) do
				t[key] = value
			end
		end
	end
	return t
end

-- Luau freezes a table in place. Lua 5.1 has no way to, and the table is
-- answered as it is.
function __NAME__.freeze(known, open, t)
	if table.freeze ~= nil and not table.isfrozen(t) then
		table.freeze(t)
	end
	return t
end

function __NAME__.isFrozen(known, open, t)
	return table.isfrozen ~= nil and table.isfrozen(t)
end
