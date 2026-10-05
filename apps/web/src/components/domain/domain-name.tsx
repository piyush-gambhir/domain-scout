import { cn } from '@/lib/utils';

/** ASCII name in mono, with the Unicode form first when it differs. */
export function DomainName({ ascii, unicode, className }: { ascii: string; unicode?: string | null; className?: string }) {
  const showUnicode = unicode && unicode !== ascii;
  return (
    <span className={cn('min-w-0 truncate font-mono', className)}>
      {showUnicode ? (
        <>
          {unicode} <span className="text-muted-foreground">{ascii}</span>
        </>
      ) : (
        ascii
      )}
    </span>
  );
}
