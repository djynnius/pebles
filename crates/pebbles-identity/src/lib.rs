//! UNIX identity for Pebbles (REQ-11..15).
//!
//! Pebbles users are real host accounts. Uids and gids must be identical on every
//! registered host; the main is the source of truth. All allocation happens inside
//! the reserved range below — see ADR-001 in the implementation plan before changing
//! either constant. Changing the range after v1 ships means chowning every home and
//! lake file on every host.

use std::collections::BTreeSet;
use thiserror::Error;

/// First uid/gid Pebbles may allocate (ADR-001).
pub const PEBBLES_UID_MIN: u32 = 60000;
/// Last uid/gid Pebbles may allocate, inclusive (ADR-001).
pub const PEBBLES_UID_MAX: u32 = 64999;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum IdentityError {
    #[error("reserved uid range {min}-{max} is exhausted", min = PEBBLES_UID_MIN, max = PEBBLES_UID_MAX)]
    RangeExhausted,
    #[error("uid {0} is outside the reserved Pebbles range")]
    OutOfRange(u32),
}

/// Allocates uids from the reserved range, lowest-free-first.
///
/// The set of used uids is seeded from the catalog (and audited against every host at
/// engine registration, which refuses on conflict — the PRD's uid-drift mitigation).
#[derive(Debug, Default)]
pub struct UidAllocator {
    used: BTreeSet<u32>,
    min: u32,
    max: u32,
}

impl UidAllocator {
    pub fn new(used: impl IntoIterator<Item = u32>) -> Self {
        Self::with_range(used, PEBBLES_UID_MIN, PEBBLES_UID_MAX)
    }

    fn with_range(used: impl IntoIterator<Item = u32>, min: u32, max: u32) -> Self {
        Self {
            used: used.into_iter().collect(),
            min,
            max,
        }
    }

    pub fn allocate(&mut self) -> Result<u32, IdentityError> {
        let next = (self.min..=self.max).find(|uid| !self.used.contains(uid));
        match next {
            Some(uid) => {
                self.used.insert(uid);
                Ok(uid)
            }
            None => Err(IdentityError::RangeExhausted),
        }
    }

    pub fn release(&mut self, uid: u32) -> Result<(), IdentityError> {
        if !(self.min..=self.max).contains(&uid) {
            return Err(IdentityError::OutOfRange(uid));
        }
        self.used.remove(&uid);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_lowest_free_uid_first() {
        let mut alloc = UidAllocator::new([PEBBLES_UID_MIN, PEBBLES_UID_MIN + 2]);
        assert_eq!(alloc.allocate(), Ok(PEBBLES_UID_MIN + 1));
        assert_eq!(alloc.allocate(), Ok(PEBBLES_UID_MIN + 3));
    }

    #[test]
    fn exhausted_range_is_refused_not_wrapped() {
        let mut alloc = UidAllocator::with_range([60000, 60001], 60000, 60001);
        assert_eq!(alloc.allocate(), Err(IdentityError::RangeExhausted));
    }

    #[test]
    fn release_rejects_uids_outside_the_range() {
        let mut alloc = UidAllocator::new([]);
        assert_eq!(alloc.release(1000), Err(IdentityError::OutOfRange(1000)));
        let uid = alloc.allocate().unwrap();
        assert_eq!(alloc.release(uid), Ok(()));
        assert_eq!(alloc.allocate(), Ok(uid));
    }
}
