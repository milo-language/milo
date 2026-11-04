// Virtual module scripts/build-playground.ts generates: std/*.milo keyed by /milo/std/<name>.
declare module "playground-std" {
  const std: Record<string, string>;
  export default std;
}
