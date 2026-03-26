import type { DiffPayload } from '../data/types';

export function DiffContent({ payload }: { payload: DiffPayload | null }) {
  const content = payload?.content ?? 'No diff loaded.';
  const lines = content.split(/\r?\n/);
  const treatAsUnifiedDiff = payload?.kind === 'git';

  return (
    <pre className="diff-code">
      {lines.map((line, index) => {
        const lineClass = treatAsUnifiedDiff
          ? line.startsWith('+++') || line.startsWith('---')
            ? 'file'
            : line.startsWith('@@')
              ? 'hunk'
              : line.startsWith('+')
                ? 'add'
                : line.startsWith('-')
                  ? 'del'
                  : 'ctx'
          : 'ctx';

        return (
          <span key={`${index}-${line}`} className={`diff-line ${lineClass}`}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}
