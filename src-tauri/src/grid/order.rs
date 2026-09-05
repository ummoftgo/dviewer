//! Display order is a list of original row numbers, never copied records.
use std::cmp::Ordering;
use std::sync::{OnceLock, atomic::{AtomicBool, Ordering as AtomicOrdering}};
use serde::{Deserialize, Serialize};
use super::Grid;
use crate::error::{Error, Result};
use crate::query::{Interpretation, Matcher};
use crate::table::{TablePage, TableSearch, TableHit, MAX_SEARCH_HITS};

const KEY_BYTES: usize = 128;
const MAX_ARENA_BYTES: usize = 256 * 1024 * 1024;

pub fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(AtomicOrdering::Relaxed) { Err(Error::Cancelled) } else { Ok(()) }
}

pub fn prefix(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) { end -= 1; }
    &text[..end]
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Sort { pub column: u32, pub descending: bool }

#[derive(Debug, Clone, Copy)]
enum Key { Empty, Int(i64), Float(f64), Text { offset: u32, len: u8 } }

fn number(text: &str) -> Option<Key> {
    let trimmed = text.trim();
    if trimmed.is_empty() { return Some(Key::Empty); }
    let digits = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        return trimmed.parse::<i64>().ok().map(Key::Int);
    }
    trimmed.parse::<f64>().ok().filter(|n| !n.is_nan()).map(Key::Float)
}

fn int_float(integer: i64, float: f64) -> Ordering {
    if float >= 9223372036854775808.0 { return Ordering::Less; }
    if float < i64::MIN as f64 { return Ordering::Greater; }
    integer.cmp(&(float as i64)).then_with(|| {
        if float.fract() > 0.0 { Ordering::Less }
        else if float.fract() < 0.0 { Ordering::Greater }
        else { Ordering::Equal }
    })
}

fn compare(left: Key, right: Key, arena: &[u8], descending: bool) -> Ordering {
    use Key::*;
    // Empty stays last in both directions.
    match (left, right) {
        (Empty, Empty) => return Ordering::Equal,
        (Empty, _) => return Ordering::Greater,
        (_, Empty) => return Ordering::Less,
        _ => {}
    }
    let order = match (left, right) {
        (Int(a), Int(b)) => a.cmp(&b),
        (Float(a), Float(b)) => a.partial_cmp(&b).unwrap(),
        (Int(a), Float(b)) => int_float(a, b),
        (Float(a), Int(b)) => int_float(b, a).reverse(),
        (Text { offset: a, len: al }, Text { offset: b, len: bl }) =>
            arena[a as usize..a as usize + al as usize].cmp(&arena[b as usize..b as usize + bl as usize]),
        (Text { .. }, _) => Ordering::Greater,
        (_, Text { .. }) => Ordering::Less,
        _ => unreachable!(),
    };
    if descending { order.reverse() } else { order }
}

fn store_text(arena: &mut Vec<u8>, value: &str, limit: usize) -> Result<Key> {
    let required = arena.len() + value.len();
    if required > limit { return Err(Error::SortTooLarge); }
    if required > arena.capacity() {
        let capacity = arena.capacity().max(128).saturating_mul(2).max(required).min(limit);
        arena.try_reserve_exact(capacity - arena.len()).map_err(|_| Error::SortTooLarge)?;
    }
    let offset = arena.len() as u32;
    arena.extend_from_slice(value.as_bytes());
    Ok(Key::Text { offset, len: value.len() as u8 })
}

#[derive(Debug)]
pub struct Order {
    pub rows: Vec<u32>,
    pub total: u32,
    pub filtered: bool,
    inverse: OnceLock<Vec<u32>>,
    pub peak_bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderStats { pub shown: u32, pub total: u32, pub index_bytes: usize, pub peak_bytes: usize }

impl Order {
    pub fn build(grid: &dyn Grid, sort: Option<Sort>, filter: &str, cancel: &AtomicBool,
        progress: &mut dyn FnMut(u32, u32)) -> Result<Self> {
        if sort.is_some_and(|s| s.column >= grid.column_count()) { return Err(Error::NoSuchCell); }
        check_cancel(cancel)?;
        let filter = filter.to_lowercase();
        let columns: Vec<u32> = if filter.is_empty() {
            sort.map(|s| vec![s.column]).unwrap_or_else(|| (0..grid.column_count().min(1)).collect())
        } else { (0..grid.column_count()).collect() };
        let mut rows = Vec::new();
        let mut keys = Vec::new();
        let mut arena = Vec::new();
        let mut current = None;
        let mut matched = filter.is_empty();
        let mut key = Key::Empty;
        let mut text_key = String::new();
        let mut text = false;
        let mut finish = |row: u32, matched: bool, key: Key, text: bool, value: &str| -> Result<()> {
            if !matched { return Ok(()); }
            rows.push(row);
            if sort.is_some() {
                let key = if text {
                    store_text(&mut arena, value, MAX_ARENA_BYTES)?
                } else { key };
                keys.push(key);
            }
            Ok(())
        };
        grid.scan(&columns, cancel, &mut |row, column, value| {
            if current != Some(row) {
                if let Some(previous) = current { finish(previous, matched, key, text, &text_key)?; }
                current = Some(row);
                matched = filter.is_empty();
                text = false;
                key = Key::Empty;
                text_key.clear();
                if row % 4096 == 0 { progress(row, grid.row_count()); }
            }
            if !matched && value.to_lowercase().contains(&filter) { matched = true; }
            if sort.is_some_and(|s| s.column == column) {
                if let Some(number) = number(value) { key = number; }
                else { text = true; text_key.push_str(prefix(value, KEY_BYTES)); }
            }
            Ok(())
        })?;
        if let Some(row) = current { finish(row, matched, key, text, &text_key)?; }
        drop(finish);
        check_cancel(cancel)?;
        let mut peak_bytes = rows.capacity() * 4 + keys.capacity() * size_of::<Key>() + arena.capacity();
        if let Some(sort) = sort {
            let mut positions: Vec<u32> = (0..rows.len() as u32).collect();
            let mut scratch = vec![0; positions.len()];
            peak_bytes += (positions.capacity() + scratch.capacity()) * 4;
            let mut width = 1;
            let mut comparisons = 0usize;
            // Fallible merge passes allow cancellation without panics or a comparator
            // that changes its ordering while the standard sort is using it.
            while width < positions.len() {
                for start in (0..positions.len()).step_by(width * 2) {
                    let middle = (start + width).min(positions.len());
                    let end = (middle + width).min(positions.len());
                    let (mut a, mut b) = (start, middle);
                    for out in &mut scratch[start..end] {
                        comparisons += 1;
                        if comparisons % 4096 == 0 { check_cancel(cancel)?; }
                        let left_first = b == end || (a < middle &&
                            compare(keys[positions[a] as usize], keys[positions[b] as usize], &arena, sort.descending)
                                .then_with(|| rows[positions[a] as usize].cmp(&rows[positions[b] as usize])) != Ordering::Greater);
                        *out = if left_first { let id = positions[a]; a += 1; id }
                            else { let id = positions[b]; b += 1; id };
                    }
                }
                std::mem::swap(&mut positions, &mut scratch);
                width *= 2;
                progress(grid.row_count(), grid.row_count());
            }
            for (at, position) in positions.into_iter().enumerate() { scratch[at] = rows[position as usize]; }
            rows = scratch;
        }
        check_cancel(cancel)?;
        progress(grid.row_count(), grid.row_count());
        Ok(Self { rows, total: grid.row_count(), filtered: !filter.is_empty(), inverse: OnceLock::new(), peak_bytes })
    }

    pub fn inverse(&self) -> &[u32] {
        self.inverse.get_or_init(|| {
            let mut inverse = vec![u32::MAX; self.total as usize];
            for (shown, &original) in self.rows.iter().enumerate() { inverse[original as usize] = shown as u32; }
            inverse
        })
    }

    pub fn stats(&self) -> OrderStats {
        OrderStats { shown: self.rows.len() as u32, total: self.total,
            index_bytes: self.rows.capacity() * 4 + self.inverse.get().map_or(0, |v| v.capacity() * 4), peak_bytes: self.peak_bytes }
    }

    pub fn page(&self, grid: &dyn Grid, start: u32, count: u32) -> Result<TablePage> {
        let start_at = (start as usize).min(self.rows.len());
        let end = start_at.saturating_add(count as usize).min(self.rows.len());
        let mut wanted: Vec<_> = self.rows[start_at..end].iter().copied().enumerate().collect();
        wanted.sort_unstable_by_key(|&(_, original)| original);
        let mut result = vec![None; wanted.len()];
        let mut at = 0;
        while at < wanted.len() {
            let mut to = at + 1;
            while to < wanted.len() && wanted[to].1 == wanted[to - 1].1 + 1 { to += 1; }
            let page = grid.page(wanted[at].1, (to - at) as u32)?;
            if page.rows.len() != to - at { return Err(Error::NoSuchRow); }
            for (row, &(position, _)) in page.rows.into_iter().zip(&wanted[at..to]) { result[position] = Some(row); }
            at = to;
        }
        Ok(TablePage { start, rows: result.into_iter().map(Option::unwrap).collect() })
    }

    pub fn search(&self, grid: &dyn Grid, query: &str, case_sensitive: bool, how: Interpretation, cancel: &AtomicBool) -> Result<TableSearch> {
        let inverse = self.inverse();
        let mut result = if self.filtered {
            let matcher = Matcher::new(query, case_sensitive, how)?;
            let mut hits = Vec::new();
            let mut capped = false;
            let columns: Vec<_> = (0..grid.column_count()).collect();
            grid.scan(&columns, cancel, &mut |row, column, value| {
                if inverse[row as usize] != u32::MAX && !query.is_empty() && matcher.matches(value) {
                    if hits.len() < MAX_SEARCH_HITS { hits.push(TableHit { row, column }); }
                    else { capped = true; }
                }
                Ok(())
            })?;
            TableSearch { hits, capped }
        } else { grid.search(query, case_sensitive, how, cancel)? };
        for hit in &mut result.hits { hit.row = inverse[hit.row as usize]; }
        result.hits.sort_unstable_by_key(|hit| (hit.row, hit.column));
        Ok(result)
    }
}

#[cfg(test)]
#[path = "order_tests.rs"]
mod tests;
