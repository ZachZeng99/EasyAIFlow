import type { ConversationMessage, GroupParticipant, GroupParticipantId } from './types.js';

const groupMentionPattern = /(^|\s)@(claude|codex|all)\b/gi;

const isGroupParticipantId = (value: string): value is GroupParticipantId =>
  value === 'claude' || value === 'codex';

export const parseGroupTargets = (
  prompt: string,
  availableParticipants: GroupParticipant[],
): GroupParticipantId[] => {
  const mentioned = new Set<GroupParticipantId>();

  for (const match of prompt.matchAll(groupMentionPattern)) {
    const raw = match[2]?.toLowerCase();
    if (raw === 'all') {
      availableParticipants
        .filter((participant) => participant.enabled)
        .forEach((participant) => mentioned.add(participant.id));
      continue;
    }

    if (raw && isGroupParticipantId(raw)) {
      const participant = availableParticipants.find(
        (candidate) => candidate.id === raw && candidate.enabled,
      );
      if (participant) {
        mentioned.add(participant.id);
      }
    }
  }

  return [...mentioned];
};

export const getLastGroupResponder = (
  messages: ConversationMessage[],
  availableParticipants: GroupParticipant[],
): GroupParticipantId | null => {
  const enabledIds = new Set(
    availableParticipants
      .filter((participant) => participant.enabled)
      .map((participant) => participant.id),
  );
  const latestReply = [...messages].reverse().find(
    (message) =>
      message.role === 'assistant' &&
      typeof message.speakerId === 'string' &&
      isGroupParticipantId(message.speakerId) &&
      enabledIds.has(message.speakerId) &&
      message.status !== 'error' &&
      message.content.trim().length > 0,
  );

  if (!latestReply?.speakerId || !isGroupParticipantId(latestReply.speakerId)) {
    return null;
  }

  return latestReply.speakerId;
};

export const resolveGroupTargets = (
  prompt: string,
  availableParticipants: GroupParticipant[],
  messages: ConversationMessage[],
): GroupParticipantId[] => {
  const explicitTargets = parseGroupTargets(prompt, availableParticipants);
  if (explicitTargets.length > 0) {
    return explicitTargets;
  }

  const lastResponder = getLastGroupResponder(messages, availableParticipants);
  return lastResponder ? [lastResponder] : [];
};
