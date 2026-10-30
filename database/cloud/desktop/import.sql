-- Immutable source bytes and an explicit previous server revision bind the one-time owner import.
create table if not exists demo_desktop.imported_earth_versions(owner_id uuid not null,workspace_id uuid not null,version_id uuid not null,grave_id bigint not null,data jsonb not null,primary key(owner_id,workspace_id,version_id),foreign key(owner_id,workspace_id) references demo_desktop.companies(owner_id,workspace_id));
alter table demo_desktop.imported_earth_versions enable row level security;
revoke all on demo_desktop.imported_earth_versions from public,anon,authenticated,service_role,demo_desktop_writer;
create or replace function demo_desktop.import_id(p_row jsonb,p_field text) returns bigint language plpgsql immutable set search_path='' as $$declare v numeric;begin
 if jsonb_typeof(p_row->p_field) is distinct from 'number' then perform demo_desktop.fail('invalid-input');end if;v:=(p_row->>p_field)::numeric;
 if v<1 or v>9007199254740991 or v<>trunc(v) then perform demo_desktop.fail('invalid-input');end if;return v::bigint;
end $$;
revoke all on all functions in schema demo_desktop from public,anon,authenticated,service_role;
