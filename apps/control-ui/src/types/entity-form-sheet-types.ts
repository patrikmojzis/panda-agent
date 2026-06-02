export type CreateSheetOptions<TForm, TContext> = {
  context: TContext
  defaultData?: Partial<TForm>
}

export type UpdateSheetOptions<TEntity, TForm, TContext> = {
  context: TContext
  entity?: TEntity
  defaultData?: Partial<TForm>
}

export type FormCreateSheetState<TForm, TContext> = {
  defaultData?: Partial<TForm>
  context?: TContext
  isOpen: boolean
  setOpen: (isOpen: boolean, options?: CreateSheetOptions<TForm, TContext>) => void
}

export type FormUpdateSheetState<TEntity, TForm, TContext> = {
  entity?: TEntity
  defaultData?: Partial<TForm>
  context?: TContext
  isOpen: boolean
  setOpen: (isOpen: boolean, options?: UpdateSheetOptions<TEntity, TForm, TContext>) => void
}
