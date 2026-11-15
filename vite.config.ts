/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173 },
  preview: { port: 4173 },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    testTimeout: 60_000,
  },
});
