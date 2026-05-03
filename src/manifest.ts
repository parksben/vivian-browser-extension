import { defineManifest } from '@crxjs/vite-plugin';

// During the migration (see docs/TECH_DESIGN.md "迁移路线"), the manifest
// points @crxjs at the existing root-level files. Paths will be rewritten to
// target src/ as each phase migrates a file into it.
export default defineManifest({
  manifest_version: 3,
  name: 'ClawTab',
  version: '1.0.0',
  description:
    'Connect your browser to an OpenClaw Gateway, enabling AI agents to observe and control browser tabs.',
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxCy1EtSUS94u0Z++ojTJYriP6D3zndf1EjywSHGqANvN62F6XLBPBwSwZrhgnh42Q0dlhDqgSiZOKNUHAoDXg93jJXpcelHG+3URZGz29uLGue2RGQ+HNmAJNxD9rNdhfqpA0K95k8lmRr48SxEK9Uafu0hI+dyWJz0ahXo/VM15dkl8Ex0eMWgoBTo4JOZVAaK6POy5xyWU8pqDMkjTJ8wKHtENm4DUaYqG7zLKPJh+mrlUGVhemlE5p7jXOA+SZDWRx+kUiUrwTTS0Lu2BnauaJ3s1E+1OlBCgTTaY+zRhLWhjHt93wPH5x92wuAHuo3yttJVhjPo0xaIMt8N3+wIDAQAB',
  permissions: ['tabs', 'activeTab', 'scripting', 'storage', 'alarms', 'sidePanel'],
  host_permissions: ['<all_urls>'],
  side_panel: {
    default_path: 'sidebar/sidebar.html',
  },
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  action: {
    default_title: 'ClawTab',
    default_icon: {
      '16': 'icons/icon16.png',
      '48': 'icons/icon48.png',
      '128': 'icons/icon128.png',
    },
  },
  icons: {
    '16': 'icons/icon16.png',
    '48': 'icons/icon48.png',
    '128': 'icons/icon128.png',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['content/content.js'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  web_accessible_resources: [
    {
      resources: ['icons/*.png'],
      matches: ['<all_urls>'],
    },
  ],
});
