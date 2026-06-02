export function FieldLabelText({ label, required }: { label: string; required?: boolean }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate">{label}</span>
      {required ? (
        <>
          <span className="shrink-0 text-destructive" aria-hidden="true">
            *
          </span>
          <span className="sr-only">required</span>
        </>
      ) : (
        <span className="shrink-0 text-[0.68rem] font-normal text-muted-foreground">(optional)</span>
      )}
    </span>
  )
}
