/**
 * eslint-plugin-conventions: project conventions oxlint has no built-in rule for (`.trellis/spec/conventions/`).
 *
 * no-platform-literal (spec 09 rule 5): outside a platform's own connector, code does not compare a platform ID with a
 * literal (`scope.platform === "onebot"`). What a platform can do is declared in `PLATFORMS`
 * (`@yesimbot/contracts/platforms`) or by its account, and read from there.
 */

/** The chat platform IDs `PLATFORMS` registers, and the retired one records still carry. */
const PLATFORM_IDS = new Set(["onebot", "wechat-bridge", "web", "xiaoheihe"]);

const noPlatformLiteral = {
  meta: {
    type: "problem",
    docs: { description: "Read platform capabilities from their declaration instead of comparing platform IDs (spec 09 rule 5)." },
    schema: [],
  },
  create(context) {
    const report = (node, id) =>
      context.report({
        node,
        message: `不按平台名「${id}」判断：平台能做什么读 @yesimbot/contracts/platforms 的声明（规范 09 第 5 条）。`,
      });
    return {
      BinaryExpression(node) {
        if (!["===", "!==", "==", "!="].includes(node.operator)) return;
        if (isPlatformValue(node.left) && isPlatformLiteral(node.right)) report(node, node.right.value);
        else if (isPlatformValue(node.right) && isPlatformLiteral(node.left)) report(node, node.left.value);
      },
      SwitchStatement(node) {
        if (!isPlatformValue(node.discriminant)) return;
        for (const item of node.cases) if (isPlatformLiteral(item.test)) report(item, item.test.value);
      },
    };
  },
};

export default {
  meta: { name: "conventions" },
  rules: { "no-platform-literal": noPlatformLiteral },
};

/** `platform`, `x.platform`, `x?.platform`, `x["platform"]`. Node's `process.platform` names an OS, not a chat platform. */
function isPlatformValue(node) {
  if (!node) return false;
  if (node.type === "ChainExpression") return isPlatformValue(node.expression);
  if (node.type === "Identifier") return node.name === "platform";
  if (node.type !== "MemberExpression") return false;
  const name = node.computed ? (node.property.type === "Literal" ? node.property.value : undefined) : node.property.name;
  if (name !== "platform") return false;
  return !(node.object.type === "Identifier" && node.object.name === "process");
}

function isPlatformLiteral(node) {
  return node?.type === "Literal" && typeof node.value === "string" && PLATFORM_IDS.has(node.value);
}
