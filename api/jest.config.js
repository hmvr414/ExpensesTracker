/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Serial for two reasons: suites share one Postgres test DB and corrupt each
  // other's data when parallel, and ts-jest workers grow to 1-2 GB each — a
  // worker per core OOMs the 16 GB dev machine when agents run `npx jest`
  // directly (bypassing the --runInBand script).
  maxWorkers: 1,
  workerIdleMemoryLimit: '1GB',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts', '!src/**/__tests__/**'],
};
