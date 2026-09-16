local G;
G = {
modules = {
["src/main"] = {
load = function(exports, ...)
local a;
a = "he said \"hi\"";
print(a);
end
}
},
records = {},
require = function(name)
local record = G.records[name];
if record ~= nil then
return record.exports;
end;
local module = G.modules[name];
local initialized = {};
local exports = setmetatable({}, {
__index = function(_, key)
if initialized[key] then
return nil;
end;
if module.names ~= nil and module.names[key] then
error(("Cannot access '%s' before initialization: '%s' has not reached it yet"):format(tostring(key), name), 2);
end;
local link = module.links ~= nil and module.links[key];
if link then
local source = G.require(link[1]);
if link[2] == nil then
return source;
end;
return source[link[2]];
end;
if module.stars ~= nil and key ~= "default" then
for _, star in module.stars do
local value = G.require(star)[key];
if value ~= nil then
return value;
end;
end;
end;
return nil;
end,
__newindex = function(target, key, value)
initialized[key] = true;
rawset(target, key, value);
end
});
record = {
loading = true,
exports = exports
};
G.records[name] = record;
module.load(exports);
record.loading = false;
return exports;
end
};
G.lines = {
[8] = {
"src/main.tilua",
2
}
};
G.require("src/main");
