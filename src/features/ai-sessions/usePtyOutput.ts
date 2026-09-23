import { useEffect } from 'react';
import { subscribePtyChannel, type PtyExitEvent, type PtyOutputEvent } from './terminalApi';

interface UsePtyOutputOptions {
  onExit: (event: PtyExitEvent) => void;
  onOutput: (event: PtyOutputEvent) => void;
  onError: (message: string) => void;
}

export function usePtyOutput({ onExit, onOutput }: UsePtyOutputOptions) {
  useEffect(() => {
    const unsubscribe = subscribePtyChannel(onOutput, onExit);

    return () => {
      unsubscribe();
    };
  }, [onExit, onOutput]);
}
