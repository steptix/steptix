import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.ai-ui-automation.runner',
  productName: 'AI UI Automation Runner',
  directories: {
    output: 'dist-electron',
  },
  files: [
    'dist-ui/**',
  ],
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
  },
  win: {
    target: ['nsis', 'zip'],
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
  },
};

export default config;
