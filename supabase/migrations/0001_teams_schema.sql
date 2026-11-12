-- Glyphi Teams schema.
--
-- A separate project, a separate schema, the same shape of security as the
-- single-player one: everything lives in `teams`, RLS is on with no policies,
-- and the only door is a `public.teams_api_*` security-definer function that is
-- revoked from anon/authenticated and granted to service_role alone. The Edge
-- Function is the only holder of that key.
--
-- What is stored here is deliberately thin: an account, a team, its members,
-- and one row per member per day with tokens and cost. Never prompts, never
-- model conversations, never file paths.

create schema if not exists teams;
revoke all on schema teams from public, anon, authenticated;
grant usage on schema teams to service_role;

create table if not exists teams.account (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  display_name text,
  created_at timestamptz not null default now(),
  constraint account_email_length check (char_length(email) between 3 and 254),
  constraint account_display_length check (display_name is null or char_length(display_name) between 1 and 80)
);

create table if not exists teams.session (
  token_hash text primary key,
  account_id uuid not null references teams.account (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint session_hash_format check (token_hash ~ '^[a-f0-9]{64}$')
);

create index if not exists session_by_account on teams.session (account_id);

create table if not exists teams.team (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references teams.account (id) on delete cascade,
  invite_code text not null unique,
  created_at timestamptz not null default now(),
  constraint team_name_length check (char_length(name) between 1 and 60),
  constraint team_code_format check (invite_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$')
);

create table if not exists teams.membership (
  team_id uuid not null references teams.team (id) on delete cascade,
  account_id uuid not null references teams.account (id) on delete cascade,
  shares_usage boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (team_id, account_id)
);

create table if not exists teams.usage_day (
  team_id uuid not null references teams.team (id) on delete cascade,
  account_id uuid not null references teams.account (id) on delete cascade,
  day date not null,
  tokens bigint not null default 0,
  cost_micros bigint not null default 0,
  tools jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  primary key (team_id, account_id, day),
  constraint usage_tokens_range check (tokens >= 0),
  constraint usage_cost_range check (cost_micros >= 0),
  constraint usage_tools_size check (pg_column_size(tools) <= 16384)
);

create index if not exists usage_by_team_day on teams.usage_day (team_id, day desc);

alter table teams.account enable row level security;
alter table teams.session enable row level security;
alter table teams.team enable row level security;
alter table teams.membership enable row level security;
alter table teams.usage_day enable row level security;

revoke all on all tables in schema teams from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema teams to service_role;

-- ---------------------------------------------------------------------------
-- Rate limiting
-- ---------------------------------------------------------------------------

create table if not exists teams.rate_limit (
  bucket text primary key,
  window_start timestamptz not null,
  hits integer not null,
  constraint rate_bucket_length check (char_length(bucket) <= 200),
  constraint rate_hits_range check (hits >= 0)
);

alter table teams.rate_limit enable row level security;
revoke all on teams.rate_limit from public, anon, authenticated;
grant select, insert, update, delete on teams.rate_limit to service_role;

create or replace function public.teams_api_rate_hit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_hits integer;
begin
  if p_limit <= 0 or p_window_seconds <= 0 then
    return false;
  end if;

  insert into teams.rate_limit as r (bucket, window_start, hits)
  values (p_bucket, v_now, 1)
  on conflict (bucket) do update
    set hits = case when r.window_start < v_now - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
        window_start = case when r.window_start < v_now - make_interval(secs => p_window_seconds) then v_now else r.window_start end
  returning r.hits into v_hits;

  return v_hits <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- Accounts and sessions
-- ---------------------------------------------------------------------------

create or replace function public.teams_api_account_register(
  p_email text,
  p_password text,
  p_display_name text
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_id uuid;
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    return jsonb_build_object('ok', false, 'error', 'email_format');
  end if;
  if char_length(coalesce(p_password, '')) < 8 or char_length(p_password) > 200 then
    return jsonb_build_object('ok', false, 'error', 'password_length');
  end if;
  if v_name is not null and char_length(v_name) > 80 then
    return jsonb_build_object('ok', false, 'error', 'display_name');
  end if;
  if exists (select 1 from teams.account where email = v_email) then
    return jsonb_build_object('ok', false, 'error', 'email_taken');
  end if;

  insert into teams.account (email, password_hash, display_name)
  values (v_email, extensions.crypt(p_password, extensions.gen_salt('bf')), coalesce(v_name, split_part(v_email, '@', 1)))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'accountId', v_id, 'email', v_email);
end;
$$;

create or replace function public.teams_api_account_login(p_email text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_row teams.account;
begin
  select * into v_row from teams.account where email = v_email;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  end if;
  if v_row.password_hash <> extensions.crypt(p_password, v_row.password_hash) then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  end if;
  return jsonb_build_object(
    'ok', true,
    'accountId', v_row.id,
    'email', v_row.email,
    'displayName', coalesce(v_row.display_name, split_part(v_row.email, '@', 1))
  );
end;
$$;

create or replace function public.teams_api_session_create(
  p_token_hash text,
  p_account uuid,
  p_expires_at timestamptz
) returns void
language sql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  insert into teams.session (token_hash, account_id, expires_at)
  values (p_token_hash, p_account, p_expires_at)
  on conflict (token_hash) do nothing;
$$;

create or replace function public.teams_api_session_auth(p_token_hash text)
returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  select jsonb_build_object(
           'accountId', a.id,
           'email', a.email,
           'displayName', coalesce(a.display_name, split_part(a.email, '@', 1))
         )
    from teams.session s
    join teams.account a on a.id = s.account_id
   where s.token_hash = p_token_hash
     and s.expires_at > now();
$$;

create or replace function public.teams_api_session_delete(p_token_hash text)
returns void
language sql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  delete from teams.session where token_hash = p_token_hash;
$$;

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------

create or replace function public.teams_api_team_create(p_account uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_code text;
  v_id uuid;
  v_try integer := 0;
begin
  if v_name is null or char_length(v_name) > 60 then
    return jsonb_build_object('ok', false, 'error', 'name');
  end if;

  loop
    v_try := v_try + 1;
    v_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 4) || '-' || substr(md5(random()::text), 1, 4));
    begin
      insert into teams.team (name, owner_id, invite_code)
      values (v_name, p_account, v_code)
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_try > 6 then
        return jsonb_build_object('ok', false, 'error', 'code_collision');
      end if;
    end;
  end loop;

  insert into teams.membership (team_id, account_id)
  values (v_id, p_account)
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'teamId', v_id, 'inviteCode', v_code, 'name', v_name);
end;
$$;

create or replace function public.teams_api_team_join(p_account uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_team teams.team;
begin
  if v_code !~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$' then
    return jsonb_build_object('ok', false, 'error', 'code_format');
  end if;

  select * into v_team from teams.team where invite_code = v_code;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'code_unknown');
  end if;

  insert into teams.membership (team_id, account_id)
  values (v_team.id, p_account)
  on conflict do nothing;

  return jsonb_build_object('ok', true, 'teamId', v_team.id, 'name', v_team.name);
end;
$$;

/**
 * Everything one account can see: each team it belongs to, its own role there,
 * the invite code when it owns the team, and per member the totals the member
 * chose to share. A member who turned sharing off is listed with `sharesUsage`
 * false and no numbers, rather than hidden.
 */
create or replace function public.teams_api_overview(p_account uuid)
returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '20s'
as $$
  with mine as (
    select m.team_id, (t.owner_id = p_account) as is_owner
      from teams.membership m
      join teams.team t on t.id = m.team_id
     where m.account_id = p_account
  ),
  members as (
    select m.team_id,
           m.account_id,
           m.shares_usage,
           m.joined_at,
           a.email,
           coalesce(a.display_name, split_part(a.email, '@', 1)) as display_name,
           (t.owner_id = m.account_id) as is_owner,
           coalesce(sum(u.tokens) filter (where m.shares_usage), 0)::bigint as tokens,
           coalesce(sum(u.cost_micros) filter (where m.shares_usage), 0)::bigint as cost_micros,
           count(distinct u.day) filter (where m.shares_usage and u.tokens > 0) as active_days,
           max(u.day) filter (where m.shares_usage) as last_day,
           coalesce(
             (select sum(u2.tokens) from teams.usage_day u2
               where u2.team_id = m.team_id and u2.account_id = m.account_id
                 and u2.day >= current_date - 6 and m.shares_usage),
             0)::bigint as tokens_7d
      from teams.membership m
      join teams.team t on t.id = m.team_id
      join teams.account a on a.id = m.account_id
      left join teams.usage_day u on u.team_id = m.team_id and u.account_id = m.account_id
     group by m.team_id, m.account_id, m.shares_usage, m.joined_at, a.email, a.display_name, t.owner_id
  )
  select coalesce(jsonb_agg(entry order by entry ->> 'name'), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'id', t.id,
               'name', t.name,
               'role', case when t.owner_id = p_account then 'owner' else 'member' end,
               'inviteCode', case when t.owner_id = p_account then t.invite_code else null end,
               'createdAt', t.created_at,
               'memberCount', (select count(*) from members mm where mm.team_id = t.id),
               'sharedCount', (select count(*) from members mm where mm.team_id = t.id and mm.shares_usage),
               'tokens', (select coalesce(sum(mm.tokens), 0) from members mm where mm.team_id = t.id),
               'tokens7d', (select coalesce(sum(mm.tokens_7d), 0) from members mm where mm.team_id = t.id),
               'costMicros', (select coalesce(sum(mm.cost_micros), 0) from members mm where mm.team_id = t.id),
               'members', coalesce(
                 (select jsonb_agg(jsonb_build_object(
                            'id', mm.account_id,
                            'email', mm.email,
                            'displayName', mm.display_name,
                            'role', case when mm.is_owner then 'owner' else 'member' end,
                            'sharesUsage', mm.shares_usage,
                            'joinedAt', mm.joined_at,
                            'tokens', mm.tokens,
                            'tokens7d', mm.tokens_7d,
                            'costMicros', mm.cost_micros,
                            'activeDays', mm.active_days,
                            'lastDay', mm.last_day
                          ) order by mm.tokens desc, mm.display_name)
                    from members mm where mm.team_id = t.id),
                 '[]'::jsonb)
             ) as entry
        from teams.team t
       where t.id in (select team_id from mine)
    ) rows;
$$;

/**
 * One member pushes its own daily aggregates. Only totals leave the machine:
 * a day, a token count, a cost estimate and the per-tool split. Rows are
 * written only for teams where the member still shares.
 */
create or replace function public.teams_api_usage_push(p_account uuid, p_days jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
set statement_timeout = '20s'
as $$
declare
  v_day jsonb;
  v_day_date date;
  v_tokens bigint;
  v_cost bigint;
  v_tools jsonb;
  v_count integer := 0;
  v_team record;
begin
  if p_days is null or jsonb_typeof(p_days) <> 'array' then
    return 0;
  end if;
  if jsonb_array_length(p_days) > 400 then
    return 0;
  end if;

  for v_team in
    select team_id from teams.membership where account_id = p_account and shares_usage
  loop
    for v_day in select * from jsonb_array_elements(p_days) loop
      begin
        v_day_date := (v_day ->> 'day')::date;
      exception when others then
        continue;
      end;
      v_tokens := greatest(coalesce((v_day ->> 'tokens')::bigint, 0), 0);
      v_cost := greatest(coalesce((v_day ->> 'costMicros')::bigint, 0), 0);
      v_tools := case when jsonb_typeof(v_day -> 'tools') = 'object' then v_day -> 'tools' else '{}'::jsonb end;

      insert into teams.usage_day as u (team_id, account_id, day, tokens, cost_micros, tools)
      values (v_team.team_id, p_account, v_day_date, v_tokens, v_cost, v_tools)
      on conflict (team_id, account_id, day) do update
        set tokens = excluded.tokens,
            cost_micros = excluded.cost_micros,
            tools = excluded.tools,
            received_at = now();
      v_count := v_count + 1;
    end loop;
  end loop;

  return v_count;
end;
$$;

create or replace function public.teams_api_sharing_set(p_account uuid, p_team uuid, p_shares boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
begin
  update teams.membership
     set shares_usage = coalesce(p_shares, true)
   where team_id = p_team and account_id = p_account;

  if not found then
    return false;
  end if;

  -- Turning sharing off removes what was already shared, so the switch means
  -- what it says instead of only stopping future uploads.
  if not coalesce(p_shares, true) then
    delete from teams.usage_day where team_id = p_team and account_id = p_account;
  end if;

  return true;
end;
$$;

create or replace function public.teams_api_member_remove(p_actor uuid, p_team uuid, p_member uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_owner uuid;
begin
  select owner_id into v_owner from teams.team where id = p_team;
  if v_owner is null then
    return false;
  end if;
  -- A member may remove themselves; only an owner may remove someone else.
  if p_member <> p_actor and v_owner <> p_actor then
    return false;
  end if;
  if p_member = v_owner then
    return false;
  end if;

  delete from teams.membership where team_id = p_team and account_id = p_member;
  delete from teams.usage_day where team_id = p_team and account_id = p_member;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock the door
-- ---------------------------------------------------------------------------

revoke all on schema teams from public;
revoke all on schema teams from anon;
revoke all on schema teams from authenticated;
grant usage on schema teams to service_role;

revoke all on all tables in schema teams from public, anon, authenticated;
grant select, insert, update, delete on all tables in schema teams to service_role;

do $$
declare
  target record;
begin
  for target in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'teams\_api\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', target.signature);
    execute format('grant execute on function %s to service_role', target.signature);
  end loop;
end;
$$;
