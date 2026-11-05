import { createApp } from 'vue';
import 'element-plus/es/components/card/style/css';
import 'element-plus/es/components/tag/style/css';
import WorkspaceChrome from './WorkspaceChrome.vue';
import './chrome.css';

const root = document.getElementById('workspace-chrome');
if (root) createApp(WorkspaceChrome).mount(root);
