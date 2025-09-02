/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  collectCoverage: true, // 啟用覆蓋率收集
  coverageDirectory: 'coverage', // 覆蓋率報告輸出目錄
  collectCoverageFrom: [ // 指定要收集覆蓋率的檔案
    'src/**/*.ts',
    '!src/**/*.d.ts', // 排除宣告檔案
    '!src/**/*.test.ts', // 排除測試檔案本身
  ],
  coverageReporters: ['text', 'lcov', 'html'], // 輸出格式：文字、lcov (用於 CI/CD 工具)、HTML
};
