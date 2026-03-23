import type { DreamRecord } from './types.js';

const isTemporaryDream = (dream: DreamRecord) => dream.isTemporary || dream.name === 'Temporary';

export const sortDreamsWithTemporaryFirst = <T extends DreamRecord>(dreams: T[]) => {
  const temporary: T[] = [];
  const regular: T[] = [];

  dreams.forEach((dream) => {
    if (isTemporaryDream(dream)) {
      temporary.push(dream);
      return;
    }

    regular.push(dream);
  });

  return [...temporary, ...regular];
};
