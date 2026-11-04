// Bun's `with { type: "text" }` import of the IR runtime (src/runtime-ir.ts).
declare module "*.ll" {
  const text: string;
  export default text;
}
