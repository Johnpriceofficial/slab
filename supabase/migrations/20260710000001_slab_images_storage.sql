-- ============================================================================
-- SlabVault — private storage bucket for slab images.
-- Layout: slabs/{inventory_number}/front.{ext} and .../back.{ext}
-- Private bucket (no public read); images are served via short-lived signed
-- URLs. Admin-only access to objects. 15 MB per file. JPEG/PNG/WEBP/HEIC.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'slab-images',
  'slab-images',
  false,
  15728640, -- 15 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Admins have full control over slab image objects; nobody else can touch them.
drop policy if exists "slab-images admin read"   on storage.objects;
drop policy if exists "slab-images admin insert" on storage.objects;
drop policy if exists "slab-images admin update" on storage.objects;
drop policy if exists "slab-images admin delete" on storage.objects;

create policy "slab-images admin read" on storage.objects
  for select to authenticated
  using (bucket_id = 'slab-images' and public.is_admin(auth.uid()));

create policy "slab-images admin insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'slab-images' and public.is_admin(auth.uid()));

create policy "slab-images admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'slab-images' and public.is_admin(auth.uid()));

create policy "slab-images admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'slab-images' and public.is_admin(auth.uid()));
