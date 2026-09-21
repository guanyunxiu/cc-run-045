/**
 * Awareness 状态：多用户光标 / 选区序列化。
 *
 * 状态结构（经 y-protocols 以二进制增量广播，服务端不解析业务字段）：
 * {
 *   user: { id, name, color },
 *   cursor: {
 *     blockId: string,        // 光标所在块
 *     index: number,          // 块内字符偏移
 *     anchor?: { blockId, index }, // 非折叠选区的锚点
 *   } | null
 * }
 */

export interface CursorPos {
  blockId: string;
  index: number;
}

export interface RemoteUser {
  id: string;
  name: string;
  color: string;
}

export interface AwarenessState {
  user: RemoteUser;
  cursor: {
    blockId: string;
    index: number;
    anchor?: CursorPos;
  } | null;
}

/**
 * 由用户 ID 确定性生成唯一标识色（HSL）。
 * 同一用户在任何文档 / 任何客户端上颜色一致，无需服务端协调。
 */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  // 固定较高饱和度与中等亮度，保证不同色相可区分且背景/文字对比清晰。
  return `hsl(${hue} 70% 45%)`;
}

export function colorWithAlpha(hsl: string, alpha: number): string {
  return hsl.replace('hsl(', 'hsla(').replace(')', ` / ${alpha})`);
}

export function buildAwarenessState(user: RemoteUser, cursor: AwarenessState['cursor']): AwarenessState {
  return { user, cursor };
}
