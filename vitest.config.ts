import { defineConfig } from "vitest/config";

// The relay has its own dependency-free `node --test` suite (relay/); keep it out of vitest.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
