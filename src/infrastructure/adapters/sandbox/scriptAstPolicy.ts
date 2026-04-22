// src/infrastructure/adapters/sandbox/scriptAstPolicy.ts

import { parse } from "acorn";
import type { Expression, Node } from "acorn";
import { full } from "acorn-walk";

export class SandboxScriptPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxScriptPolicyError";
  }
}

function unwrapCalleeExpression(node: Expression): Expression {
  let n: Expression = node;
  for (;;) {
    if (n.type === "ParenthesizedExpression") {
      n = n.expression;
      continue;
    }
    if (n.type === "SequenceExpression") {
      n = n.expressions[n.expressions.length - 1];
      continue;
    }
    return n;
  }
}

/** `new Function`, `new (Function)`, `new x.Function`, `new (0, Function)` */
function calleeRefersToFunctionConstructor(callee: Expression): boolean {
  const inner = unwrapCalleeExpression(callee);
  if (inner.type === "Identifier" && inner.name === "Function") return true;
  if (inner.type === "MemberExpression" && !inner.computed) {
    return inner.property.type === "Identifier" && inner.property.name === "Function";
  }
  return false;
}

/**
 * Best-effort static rules before QuickJS runs: no computed `obj[expr]` (including
 * `obj?.[expr]`), and no `new Function` (including parenthesized / qualified callees).
 * Does not replace QuickJS memory, time limits, or output caps.
 */
export function assertScriptPassesAstPolicy(script: string): void {
  let ast: Node;
  try {
    ast = parse(script, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new SandboxScriptPolicyError(`Script parse error: ${msg}`);
  }

  full(ast, (node) => {
    if (node.type === "MemberExpression" && node.computed) {
      throw new SandboxScriptPolicyError(
        "Computed member expressions (e.g. obj[key]) are not allowed in sandbox scripts",
      );
    }
    if (node.type === "NewExpression" && calleeRefersToFunctionConstructor(node.callee)) {
      throw new SandboxScriptPolicyError(
        "`new Function` is not allowed in sandbox scripts",
      );
    }
  });
}
