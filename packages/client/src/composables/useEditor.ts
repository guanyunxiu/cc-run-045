import { ref, shallowRef, onBeforeUnmount, type Ref } from 'vue';
import { EditorSession } from '../collab/session.js';
import type { ConnectionPhase } from '../network/network.js';
import type { AwarenessState } from '../collab/awareness-state.js';
import type { BlockRegistry } from '@blockeditor/core';

export interface UseEditorOptions {
  docId: string;
  user: { id: string; name: string };
  token: () => string | null;
  wsBaseUrl: string;
  httpBaseUrl: string;
  registry?: BlockRegistry;
}

export interface EditorApi {
  session: Ref<EditorSession | null>;
  phase: Ref<ConnectionPhase>;
  phaseDetail: Ref<string>;
  remoteUsers: Ref<Map<number, AwarenessState>>;
  mount: (el: HTMLElement) => Promise<void>;
  setHeading: (level: number) => void;
  setBlockType: (type: string) => void;
  insertBlock: (type: string) => void;
  toggleMark: (mark: 'bold' | 'italic' | 'underline' | 'strike' | 'code') => void;
  undo: () => void;
  redo: () => void;
}

export function useEditor(options: UseEditorOptions): EditorApi {
  const session = shallowRef<EditorSession | null>(null);
  const phase = ref<ConnectionPhase>('offline');
  const phaseDetail = ref('');
  const remoteUsers = ref(new Map<number, AwarenessState>());
  let detachStatus: (() => void) | null = null;
  let detachRemotes: (() => void) | null = null;

  const mount = async (el: HTMLElement): Promise<void> => {
    const s = new EditorSession(options);
    detachStatus = s.onStatus((next, detail) => {
      phase.value = next;
      phaseDetail.value = detail ?? '';
    });
    detachRemotes = s.onRemoteUsers((states) => {
      remoteUsers.value = new Map(states);
    });
    await s.mount(el);
    session.value = s;
  };

  onBeforeUnmount(() => {
    detachStatus?.();
    detachRemotes?.();
    session.value?.destroy();
  });

  return {
    session,
    phase,
    phaseDetail,
    remoteUsers,
    mount,
    setHeading: (level) => session.value?.setHeading(level),
    setBlockType: (type) => session.value?.setBlockType(type),
    insertBlock: (type) => session.value?.insertBlock(type),
    toggleMark: (mark) => session.value?.toggleMark(mark),
    undo: () => session.value?.undo(),
    redo: () => session.value?.redo(),
  };
}
