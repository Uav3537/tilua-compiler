local __NAME__ = {}

function __NAME__.find(t, test)
	for i = 1, #t do
		if test(t[i], i) then
			return t[i]
		end
	end
	return nil
end

function __NAME__.findIndex(t, test)
	for i = 1, #t do
		if test(t[i], i) then
			return i
		end
	end
	return nil
end

function __NAME__.filter(t, test)
	local out = {}
	for i = 1, #t do
		if test(t[i], i) then
			out[#out + 1] = t[i]
		end
	end
	return out
end

function __NAME__.map(t, transform)
	local out = {}
	for i = 1, #t do
		out[i] = transform(t[i], i)
	end
	return out
end

function __NAME__.forEach(t, visit)
	for i = 1, #t do
		visit(t[i], i)
	end
end

function __NAME__.some(t, test)
	for i = 1, #t do
		if test(t[i], i) then
			return true
		end
	end
	return false
end

function __NAME__.every(t, test)
	for i = 1, #t do
		if not test(t[i], i) then
			return false
		end
	end
	return true
end

function __NAME__.reduce(t, step, initial)
	local total = initial
	for i = 1, #t do
		total = step(total, t[i], i)
	end
	return total
end

function __NAME__.includes(t, value)
	for i = 1, #t do
		if t[i] == value then
			return true
		end
	end
	return false
end

function __NAME__.indexOf(t, value, start)
	for i = start or 1, #t do
		if t[i] == value then
			return i
		end
	end
	return nil
end

function __NAME__.join(t, separator)
	local out = {}
	for i = 1, #t do
		out[i] = tostring(t[i])
	end
	return table.concat(out, separator or ",")
end

function __NAME__.concat(t, ...)
	local out = {}
	table.move(t, 1, #t, 1, out)
	for i = 1, select("#", ...) do
		local part = select(i, ...)
		table.move(part, 1, #part, #out + 1, out)
	end
	return out
end

-- An inclusive range, as `string.sub` takes: `slice(2, 3)` is the second and
-- third elements, and a negative counts back from the last.
function __NAME__.slice(t, start, stop)
	local n = #t
	local from = start or 1
	local to = stop or n
	if from < 0 then from = n + from + 1 end
	if to < 0 then to = n + to + 1 end
	if from < 1 then from = 1 end
	if to > n then to = n end
	local out = {}
	for i = from, to do
		out[#out + 1] = t[i]
	end
	return out
end

-- One level, as JavaScript's `flat()` does by default.
function __NAME__.flat(t)
	local out = {}
	for i = 1, #t do
		local value = t[i]
		if type(value) == "table" then
			table.move(value, 1, #value, #out + 1, out)
		else
			out[#out + 1] = value
		end
	end
	return out
end

function __NAME__.reverse(t)
	local n = #t
	for i = 1, n // 2 do
		t[i], t[n - i + 1] = t[n - i + 1], t[i]
	end
	return t
end

function __NAME__.sort(t, compare)
	if compare then
		table.sort(t, compare)
	else
		table.sort(t)
	end
	return t
end

function __NAME__.push(t, ...)
	local n = #t
	for i = 1, select("#", ...) do
		t[n + i] = select(i, ...)
	end
	return #t
end

function __NAME__.pop(t)
	local n = #t
	local last = t[n]
	t[n] = nil
	return last
end

function __NAME__.shift(t)
	return table.remove(t, 1)
end

function __NAME__.unshift(t, ...)
	for i = select("#", ...), 1, -1 do
		table.insert(t, 1, (select(i, ...)))
	end
	return #t
end
