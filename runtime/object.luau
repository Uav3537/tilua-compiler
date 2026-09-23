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
