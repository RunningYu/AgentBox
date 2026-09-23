import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface SpeechEvent {
  kind: 'error' | 'ready' | 'status' | 'stopped' | 'transcript';
  message?: string;
  recordingId: string;
  text?: string;
  isFinal?: boolean;
}

export function startSpeechRecognition(locale = 'zh-CN'): Promise<string> {
  return invoke<string>('start_speech_recognition', { locale });
}

export async function stopSpeechRecognition(recordingId: string): Promise<SpeechEvent> {
  await invoke('stop_speech_recognition', { recordingId });
  return invoke<SpeechEvent>('wait_speech_recognition_result', { recordingId });
}

export function listenSpeechEvents(handler: (event: SpeechEvent) => void): Promise<UnlistenFn> {
  return listen<SpeechEvent>('speech-event', (event) => handler(event.payload));
}
