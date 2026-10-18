import { ThemeMode } from './settings.js';

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme;
}