module.exports = {
    default: {
        requireModule: ['tsx/cjs'],
        require: [
            'features/support/globals.ts', // 第一個：設定 esbuild 全域常數，不可有 import
            'features/support/hooks.ts',   // 第二個：Cucumber hooks（After 等）
            'features/step-definitions/**/*.ts',
        ],
        paths: ['features/**/*.feature'],
        format: ['progress'],
        publishQuiet: true,
    },
};
