// @anchor-lang/core expects a global Buffer in the browser. Must be imported first.
import { Buffer } from "buffer";

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
