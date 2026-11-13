-- Glyphi Teams: the manager surface.
--
-- Two additions to the schema: a per-member daily token cap (the rate limit the
-- manager enforces) and the team chat. Messages are stored as ciphertext and an
-- initialisation vector only — the key is derived in the app from the team
-- secret and never sent here, so the database cannot read a message.

create table if not exists teams.member_limit (
  team_id uuid not null references teams.team (id) on delete cascade,
  account_id uuid not null references teams.account (id) on delete cascade,
  daily_tokens bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (team_id, account_id),
  constraint limit_range check (daily_tokens >= 0 and daily_tokens <= 1000000000000)
);

create table if not exists teams.message (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams.team (id) on delete cascade,
  account_id uuid not null references teams.account (id) on delete cascade,
  cipher text not null,
  iv text not null,
  created_at timestamptz not null default now(),
  constraint message_cipher_size check (char_length(cipher) between 1 and 8192),
  constraint message_iv_size check (char_length(iv) between 8 and 64)
);

create index if not exists message_by_team on teams.message (team_id, created_at desc);

alter table teams.member_limit enable row level security;
alter table teams.message enable row level security;

revoke all on teams.member_limit from public, anon, authenticated;
revoke all on teams.message from public, anon, authenticated;
grant select, insert, update, delete on teams.member_limit to service_role;
grant select, insert, update, delete on teams.message to service_role;

-- ---------------------------------------------------------------------------
-- Rate limiting policy
-- ---------------------------------------------------------------------------

/**
 * Only an owner sets a cap. A cap of zero clears it, which is how a manager
 * removes a limit without a separate endpoint.
 */
create or replace function public.teams_api_limit_set(
  p_actor uuid,
  p_team uuid,
  p_member uuid,
  p_daily_tokens bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_owner uuid;
  v_cap bigint := greatest(coalesce(p_daily_tokens, 0), 0);
begin
  select owner_id into v_owner from teams.team where id = p_team;
  if v_owner is null then
    return jsonb_build_object('ok', false, 'error', 'team_unknown');
  end if;
  if v_owner <> p_actor then
    return jsonb_build_object('ok', false, 'error', 'not_allowed');
  end if;
  if not exists (select 1 from teams.membership where team_id = p_team and account_id = p_member) then
    return jsonb_build_object('ok', false, 'error', 'not_a_member');
  end if;
  if v_cap > 1000000000000 then
    return jsonb_build_object('ok', false, 'error', 'limit_range');
  end if;

  if v_cap = 0 then
    delete from teams.member_limit where team_id = p_team and account_id = p_member;
  else
    insert into teams.member_limit as l (team_id, account_id, daily_tokens, updated_at)
    values (p_team, p_member, v_cap, now())
    on conflict (team_id, account_id) do update
      set daily_tokens = excluded.daily_tokens,
          updated_at = now();
  end if;

  return jsonb_build_object('ok', true, 'memberId', p_member, 'dailyTokens', v_cap);
end;
$$;

/**
 * The caps and today's spend, for the members of one team. A cap is a policy the
 * team agreed on, so every member can read the set; the numbers behind it are
 * the same daily totals the board already shows.
 */
create or replace function public.teams_api_limits(p_account uuid, p_team uuid)
returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '20s'
as $$
  select coalesce(jsonb_agg(entry order by entry ->> 'displayName'), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'memberId', m.account_id,
               'displayName', coalesce(a.display_name, split_part(a.email, '@', 1)),
               'dailyTokens', coalesce(l.daily_tokens, 0),
               'todayTokens', coalesce(t.tokens, 0),
               'over', coalesce(l.daily_tokens, 0) > 0 and coalesce(t.tokens, 0) > coalesce(l.daily_tokens, 0)
             ) as entry
        from teams.membership m
        join teams.account a on a.id = m.account_id
        left join teams.member_limit l on l.team_id = m.team_id and l.account_id = m.account_id
        left join (
          select account_id, sum(tokens)::bigint as tokens
            from teams.usage_day
           where team_id = p_team and day = current_date
           group by account_id
        ) t on t.account_id = m.account_id
       where m.team_id = p_team
         and exists (select 1 from teams.membership me where me.team_id = p_team and me.account_id = p_account)
    ) rows;
$$;

-- ---------------------------------------------------------------------------
-- Team chat
-- ---------------------------------------------------------------------------

/**
 * A member writes one message. The body arrives already sealed: the app sends
 * AES-256-GCM ciphertext, and only the ciphertext is kept. The newest 500
 * messages per team are retained; older ones are dropped with the same write.
 */
create or replace function public.teams_api_message_send(
  p_account uuid,
  p_team uuid,
  p_cipher text,
  p_iv text
) returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_id uuid;
  v_at timestamptz;
begin
  if not exists (select 1 from teams.membership where team_id = p_team and account_id = p_account) then
    return jsonb_build_object('ok', false, 'error', 'not_a_member');
  end if;
  if p_cipher is null or char_length(p_cipher) not between 1 and 8192
     or p_iv is null or char_length(p_iv) not between 8 and 64 then
    return jsonb_build_object('ok', false, 'error', 'message_invalid');
  end if;

  insert into teams.message (team_id, account_id, cipher, iv)
  values (p_team, p_account, p_cipher, p_iv)
  returning id, created_at into v_id, v_at;

  delete from teams.message
   where team_id = p_team
     and id in (
       select id from teams.message
        where team_id = p_team
        order by created_at desc
        offset 500
     );

  return jsonb_build_object('ok', true, 'id', v_id, 'createdAt', v_at);
end;
$$;

/**
 * The last page of the team conversation, oldest first. `p_before` pages
 * backwards; a null value starts at the newest message.
 */
create or replace function public.teams_api_messages(
  p_account uuid,
  p_team uuid,
  p_limit integer,
  p_before timestamptz
) returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '20s'
as $$
  select coalesce(jsonb_agg(entry order by entry ->> 'createdAt'), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'id', msg.id,
               'memberId', msg.account_id,
               'displayName', coalesce(a.display_name, split_part(a.email, '@', 1)),
               'cipher', msg.cipher,
               'iv', msg.iv,
               'mine', msg.account_id = p_account,
               'createdAt', msg.created_at
             ) as entry
        from (
          select * from teams.message
           where team_id = p_team
             and (p_before is null or created_at < p_before)
           order by created_at desc
           limit least(greatest(coalesce(p_limit, 50), 1), 200)
        ) msg
        join teams.account a on a.id = msg.account_id
       where exists (select 1 from teams.membership me where me.team_id = p_team and me.account_id = p_account)
    ) rows;
$$;

-- ---------------------------------------------------------------------------
-- Removing a member also drops their messages
-- ---------------------------------------------------------------------------

create or replace function public.teams_api_member_remove(p_actor uuid, p_team uuid, p_member uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_owner uuid;
  v_rows integer := 0;
  v_extra integer := 0;
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
  get diagnostics v_rows = row_count;
  delete from teams.usage_day where team_id = p_team and account_id = p_member;
  delete from teams.member_limit where team_id = p_team and account_id = p_member;
  delete from teams.message where team_id = p_team and account_id = p_member;
  get diagnostics v_extra = row_count;
  return v_rows > 0 or v_extra > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lock the door
-- ---------------------------------------------------------------------------

do $$
declare
  target record;
begin
  for target in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('teams_api_limit_set', 'teams_api_limits', 'teams_api_message_send', 'teams_api_messages', 'teams_api_member_remove')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', target.signature);
    execute format('grant execute on function %s to service_role', target.signature);
  end loop;
end;
$$;
