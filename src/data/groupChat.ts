import type { ConversationMessage, GroupParticipant, GroupParticipantId } from './types.js';

const groupMentionPattern = /(^|[^@\w])@(claude|codex|all)\b/gi;

export const hasGroupMention = (prompt: string) =>
  new RegExp(groupMentionPattern.source, 'i').test(prompt);

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
      (message.status === undefined || message.status === 'complete' || message.status === 'success') &&
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
  selectedTargets?: string[],
): GroupParticipantId[] => {
  const explicitTargets = parseGroupTargets(prompt, availableParticipants);
  const explicitlyAddressed = hasGroupMention(prompt);
  if (selectedTargets) {
    const enabledIds = new Set(availableParticipants.filter((p) => p.enabled).map((p) => p.id));
    return selectedTargets.length > 0 && selectedTargets.every((id) =>
      isGroupParticipantId(id) && enabledIds.has(id) && (!explicitlyAddressed || explicitTargets.includes(id)))
      ? [...new Set(selectedTargets)] as GroupParticipantId[]
      : [];
  }
  if (explicitlyAddressed) return explicitTargets;

  const lastResponder = getLastGroupResponder(messages, availableParticipants);
  const defaultId = lastResponder ?? availableParticipants.find((participant) => participant.enabled)?.id;
  return defaultId ? [defaultId] : [];
};
