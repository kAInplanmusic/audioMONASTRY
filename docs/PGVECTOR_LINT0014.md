---
title: pgvector Setup & Lint 0014 Compliance
date: 2026-09-03
version: 1.0
---

# Supabase Lint 0014: pgvector in Extensions Schema

## Overview

This document describes the implementation of **Supabase Lint 0014 compliance** for the audioMONASTRY project. The warning occurs when the PostgreSQL `pgvector` extension is installed in the `public` schema instead of a dedicated `extensions` schema.

## Problem Statement

**Lint 0014 — Extension in Public** warns that:
- Extension functionality (types, functions, operators) may be exposed unintentionally through Supabase's API surface
- The public schema becomes cluttered with extension objects
- Naming conflicts may increase
- The public schema is less intentionally controlled

Reference: [Supabase Database Advisors — Lint 0014](https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0014_extension_in_public)

## Solution Implemented

### Migration Files

Two parallel migration files implement the fix:

1. **`supabase/migrations/004_pgvector_extensions_schema.sql`**
   - Supabase-specific location for local development
   - Uses `begin; ... commit;` transaction wrapping

2. **`database/ai_migration_004.sql`**
   - audioMONASTRY migration system directory
   - Maintains consistency with existing migration naming (ai_migration_NNN.sql)
   - Integrated with `ai_migrations` version tracking table

### Key Components

#### 1. Extensions Schema Creation
```sql
create schema if not exists extensions;
```
- Creates a dedicated schema for all PostgreSQL extensions
- Prevents polluting the public schema
- Not exposed through Supabase's auto-generated API

#### 2. pgvector Installation
```sql
create extension if not exists vector
with schema extensions;
```
- Installs pgvector in the `extensions` schema (not `public`)
- Idempotent: safe to re-run
- Vector type becomes `extensions.vector` when qualified

#### 3. Idempotent & Non-Destructive
- Uses `create schema if not exists`
- Uses `create extension if not exists`
- Tracks version in `ai_migrations` table
- Maintains backward compatibility

## Usage Patterns

### For Development Purposes

When pgvector is needed for embeddings or vector similarity, follow these patterns:

#### Creating Embedding Columns
```sql
-- CORRECT: Qualified type
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding extensions.vector(1536),  -- 1536 for OpenAI embeddings
  created_at timestamptz not null default now()
);

-- WRONG: Unqualified (will fail without extensions schema)
-- embedding vector(1536)
```

#### Creating Vector Indexes
```sql
-- CORRECT: Using qualified operator class
create index on public.documents
using ivfflat (embedding extensions.vector_cosine_ops)
with (lists = 100);

-- For L2 distance:
create index on public.documents
using ivfflat (embedding extensions.vector_l2_ops)
with (lists = 100);
```

#### Similarity Search Queries
```sql
-- CORRECT: Type casting to extensions.vector
select 
  id, 
  content,
  embedding <-> $1::extensions.vector as distance
from public.documents
order by embedding <-> $1::extensions.vector
limit 10;

-- Example with 1536-dimensional embedding:
select 
  id, 
  content,
  embedding <-> '[0.1, 0.2, ...(1536 values)]'::extensions.vector as distance
from public.documents
order by embedding <-> '[0.1, 0.2, ...(1536 values)]'::extensions.vector
limit 5;
```

### Verifying Installation

```sql
-- Check if extension is installed
select * from pg_extension where extname = 'vector';

-- Check extension schema
select * from information_schema.schemata 
where schema_name = 'extensions';

-- List all objects in extensions schema
select * from information_schema.tables 
where table_schema = 'extensions';
```

## Pre-Migration Checks

Before applying this migration in production, verify:

- [ ] No existing `CREATE EXTENSION vector` statements in `public` schema
- [ ] No existing SQL functions that reference `public.vector` unqualified
- [ ] No client-side type definitions assuming `public.vector`
- [ ] No `search_path` settings that would need updating
- [ ] Database backup taken (as per Supabase best practices)

## Rollback Procedure

If the migration needs to be reversed:

```sql
-- CAUTION: Only execute if necessary and after backup!
drop schema if exists extensions cascade;
delete from public.ai_migrations where version = '004';
```

⚠️ **WARNING**: Dropping the extensions schema with `CASCADE` will remove all dependent objects. Only execute this after:
1. Taking a database backup
2. Verifying no tables depend on vector columns
3. Confirming the rollback is absolutely necessary

## Integration with audioMONASTRY Architecture

### Current Status
- **No pgvector usage currently exists** in the codebase
- Migration is **proactive** — preparing for future embedding/similarity features
- Embedding references in the code (e.g., `src/ai/embeddingCache.ts`) are in-memory only, not database-backed

### Future Use Cases
When audioMONASTRY adds database-backed embeddings for features like:
- AI prompt similarity matching
- Audio sample content-based retrieval
- Semantic search in the sample library

Simply follow the **Usage Patterns** section above with the qualified `extensions.vector` type.

### No Breaking Changes
- Existing AI infrastructure migrations (001–003) are unaffected
- RLS policies remain unchanged
- No modifications to public schema tables
- Backward compatible with existing code

## References

- [Supabase pgvector Documentation](https://supabase.com/docs/guides/database/extensions/pgvector)
- [Supabase Database Advisors](https://supabase.com/docs/guides/database/database-advisors)
- [pgvector GitHub Repository](https://github.com/pgvector/pgvector)
- [PostgreSQL Extension Management](https://www.postgresql.org/docs/current/sql-createextension.html)

## Related Documentation

- `database/ai_migration_001.sql` — AI Sessions & Jobs
- `database/ai_migration_002.sql` — System Prompts & Evaluations
- `database/ai_migration_003.sql` — RLS Policies (consolidated)
- `database/schema.sql` — Sample Library & Music Tracks

---

**Last Updated:** 2026-09-03  
**Maintainer:** audioMONASTRY Development Team
