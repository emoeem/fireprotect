/**
 * Type declarations for statically imported WebAssembly modules.
 *
 * wrangler's CompiledWasm rule turns `import x from "./x.wasm"` into a
 * pre-compiled `WebAssembly.Module` — the only form Cloudflare accepts, since
 * runtime instantiation from bytes is rejected. TypeScript has no idea what a
 * `.wasm` import is, so the shape is declared here.
 */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
