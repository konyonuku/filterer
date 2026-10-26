import { invoke, isTauri } from '@tauri-apps/api/core';
import { confirm, open } from '@tauri-apps/plugin-dialog';

export const desktop = isTauri();
export const request = <T,>(payload: Record<string, unknown>) => invoke<T>('catalog', { request: payload });
export const cancel = () => invoke('cancel_operation');
export async function confirmAction(message: string): Promise<boolean> {
  return desktop ? await confirm(message, { title: 'Filterer', kind: 'warning' }) : window.confirm(message);
}
export async function chooseFfprobe(): Promise<string | null> {
  return await open({ multiple: false, title: 'Select ffprobe.exe', filters: [{ name: 'ffprobe', extensions: ['exe'] }] }) as string | null;
}
export async function chooseFolder(): Promise<string | null> {
  return await open({ directory: true, multiple: false, title: 'Select folder' }) as string | null;
}
export async function chooseFile(images = false): Promise<string | null> {
  return await open({ multiple: false, title: images ? 'Select image' : 'Select player executable',
    ...(images ? { filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }] } : {}) }) as string | null;
}
