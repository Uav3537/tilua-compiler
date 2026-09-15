/**
 * Constructors for luau-parser nodes.
 *
 * Lowering builds a Luau tree from scratch, and luau-parser's printer reads
 * only node shapes, never positions — so every node gets the same empty span.
 */
import type * as L from "luau-parser"

const NO_SPAN = { line: { start: 0, end: 0 }, column: { start: 0, end: 0 } }
const span = (): L.BaseNode => ({ line: { ...NO_SPAN.line }, column: { ...NO_SPAN.column } })

// ------------------------------------------------------------
// Expressions
// ------------------------------------------------------------

export const identifier = (name: string): L.Identifier => ({ type: "Identifier", name, ...span() })
export const nil = (): L.NilLiteral => ({ type: "NilLiteral", ...span() })
export const boolean = (value: boolean): L.BooleanLiteral => ({ type: "BooleanLiteral", value, ...span() })
export const number = (value: number, raw = String(value)): L.NumberLiteral => ({ type: "NumberLiteral", value, raw, ...span() })
export const string = (value: string): L.StringLiteral => ({ type: "StringLiteral", value, raw: "", ...span() })

export const member = (object: L.Expression, property: string): L.MemberExpression | L.IndexExpression =>
    isLuauName(property)
        ? { type: "MemberExpression", object, property: identifier(property), ...span() }
        : index(object, string(property))

export const index = (object: L.Expression, key: L.Expression): L.IndexExpression =>
    ({ type: "IndexExpression", object, index: key, ...span() })

export const call = (callee: L.Expression, args: L.Expression[]): L.CallExpression =>
    ({ type: "CallExpression", callee, arguments: args, ...span() })

export const methodCall = (object: L.Expression, method: string, args: L.Expression[]): L.MethodCallExpression =>
    ({ type: "MethodCallExpression", object, method: identifier(method), arguments: args, ...span() })

export const functionExpression = (func: L.FunctionBody): L.FunctionExpression =>
    ({ type: "FunctionExpression", func, ...span() })

export const binary = (operator: L.BinaryExpression["operator"], left: L.Expression, right: L.Expression): L.BinaryExpression =>
    ({ type: "BinaryExpression", operator, left, right, ...span() })

export const unary = (operator: L.UnaryExpression["operator"], argument: L.Expression): L.UnaryExpression =>
    ({ type: "UnaryExpression", operator, argument, ...span() })

export const parenthesized = (expression: L.Expression): L.ParenthesizedExpression =>
    ({ type: "ParenthesizedExpression", expression, ...span() })

export const table = (fields: L.TableField[]): L.TableExpression => ({ type: "TableExpression", fields, ...span() })

/** A table field `key = value`, written `["key"] = value` when `key` is not a name. */
export const field = (key: string, value: L.Expression): L.TableField =>
    isLuauName(key)
        ? { type: "TableFieldNamed", name: identifier(key), value }
        : { type: "TableFieldComputed", key: string(key), value }

// ------------------------------------------------------------
// Statements
// ------------------------------------------------------------

export const block = (statements: L.Statement[]): L.Block => ({ type: "Block", statements, ...span() })

export const local = (names: string[], init: L.Expression[]): L.LocalStatement => ({
    type: "LocalStatement",
    names: names.map(name => ({ type: "TypedIdentifier", name, ...span() })),
    init,
    ...span(),
})

export const assign = (targets: L.Expression[], values: L.Expression[]): L.AssignmentStatement =>
    ({ type: "AssignmentStatement", targets, values, ...span() })

export const callStatement = (expression: L.CallExpression | L.MethodCallExpression): L.CallStatement =>
    ({ type: "CallStatement", expression, ...span() })

export const ifThen = (condition: L.Expression, body: L.Statement[]): L.IfStatement => ({
    type: "IfStatement",
    clauses: [{ type: "IfClause", condition, body: block(body), ...span() }],
    ...span(),
})

export const doBlock = (body: L.Statement[]): L.DoStatement => ({ type: "DoStatement", body: block(body), ...span() })

export const breakStatement = (): L.BreakStatement => ({ type: "BreakStatement", ...span() })

/** `repeat <body> until <condition>`. With `until true` it runs once, which is
 *  how a `continue` is built in a Lua without one. */
export const repeatUntil = (body: L.Statement[], condition: L.Expression): L.RepeatStatement =>
    ({ type: "RepeatStatement", body: block(body), condition, ...span() })

export const genericFor = (variables: string[], iterators: L.Expression[], body: L.Statement[]): L.GenericForStatement => ({
    type: "GenericForStatement",
    variables: variables.map(name => ({ type: "TypedIdentifier", name, ...span() })),
    iterators,
    body: block(body),
    ...span(),
})

export const numericFor = (variable: string, start: L.Expression, end: L.Expression, body: L.Statement[]): L.NumericForStatement => ({
    type: "NumericForStatement",
    variable: { type: "TypedIdentifier", name: variable, ...span() },
    start,
    end,
    body: block(body),
    ...span(),
})

export const returns = (args: L.Expression[]): L.ReturnStatement => ({ type: "ReturnStatement", arguments: args, ...span() })

export const functionBody = (params: string[], statements: L.Statement[], hasVarargs = false): L.FunctionBody => ({
    type: "FunctionBody",
    generics: [],
    params: params.map(name => ({ type: "FunctionParameter", name, ...span() })),
    hasVarargs,
    body: block(statements),
    ...span(),
})

export const localFunction = (name: string, func: L.FunctionBody): L.LocalFunctionStatement =>
    ({ type: "LocalFunctionStatement", name: identifier(name), func, ...span() })

export const program = (statements: L.Statement[]): L.Program => ({ type: "Program", body: block(statements), ...span() })

// ------------------------------------------------------------
// Names
// ------------------------------------------------------------

/** Luau's reserved words. tilua reserves most of them too — `local` is the
 *  exception, so a tilua name can still be one of these. */
export const LUAU_KEYWORDS = new Set([
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in",
    "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
])

/** Can `name` be written bare in Luau — as a variable, `t.name` or `{ name = v }`? */
export function isLuauName(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !LUAU_KEYWORDS.has(name)
}
