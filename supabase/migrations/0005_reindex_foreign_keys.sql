-- =============================================================================
-- 0005 · Re-apply "every foreign key is indexed"
--
-- 0001 generated FK indexes from the catalogue, which covered every foreign key
-- that existed at that moment. 0003 then added quote.uploaded_by and the job
-- table, and the rule silently stopped holding for the new columns — caught by
-- npm run verify:rls, which is the point of having it.
--
-- Re-running the same loop is idempotent (create index if not exists) and is
-- the right move after any migration that adds a foreign key.
-- =============================================================================

do $$
declare
  r record;
begin
  for r in
    select con.conname,
           cl.relname as tbl,
           string_agg(quote_ident(att.attname), ', ' order by k.ord) as cols
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
    where con.contype = 'f' and n.nspname = 'public'
    group by con.conname, cl.relname
  loop
    execute format('create index if not exists %I on public.%I (%s)',
                   left('idx_' || r.conname, 63), r.tbl, r.cols);
  end loop;

  -- and every tenant_id, for the same reason
  for r in
    select c.relname as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
      and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
  loop
    execute format('create index if not exists %I on public.%I (tenant_id)',
                   left('idx_' || r.tbl || '_tenant_id', 63), r.tbl);
  end loop;
end;
$$;
