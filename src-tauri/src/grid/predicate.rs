//! Explicit AND conditions over complete source values.
use super::{GridScalar, ScalarKind};
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

pub const MAX_PREDICATES: usize = 32;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PredicateOp {
    Equals,
    Contains,
    Gt,
    Gte,
    Lt,
    Lte,
    Empty,
    Null,
    Missing,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Predicate {
    pub column: u32,
    pub op: PredicateOp,
    #[serde(default)]
    pub value: String,
}

/// Whitespace may surround a number; the entire trimmed value must be finite.
/// Integer comparisons remain exact even above f64's integer precision.
#[derive(Debug, Clone, Copy)]
enum Number {
    Integer(i128),
    Float(f64),
}

fn number(text: &str) -> Option<Number> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(integer) = text.parse::<i128>() {
        return Some(Number::Integer(integer));
    }
    text.parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .map(Number::Float)
}

fn compare(left: Number, right: Number) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (left, right) {
        (Number::Integer(a), Number::Integer(b)) => a.cmp(&b),
        (Number::Float(a), Number::Float(b)) => a.partial_cmp(&b).unwrap(),
        (Number::Integer(a), Number::Float(b)) => {
            if b >= i128::MAX as f64 {
                return Ordering::Less;
            }
            if b < i128::MIN as f64 {
                return Ordering::Greater;
            }
            a.cmp(&(b as i128)).then_with(|| {
                if b.fract() > 0.0 {
                    Ordering::Less
                } else if b.fract() < 0.0 {
                    Ordering::Greater
                } else {
                    Ordering::Equal
                }
            })
        }
        (Number::Float(a), Number::Integer(b)) => {
            compare(Number::Integer(b), Number::Float(a)).reverse()
        }
    }
}

pub fn validate(predicates: &[Predicate], columns: u32) -> Result<()> {
    if predicates.len() > MAX_PREDICATES {
        return Err(invalid());
    }
    for predicate in predicates {
        if predicate.column >= columns {
            return Err(Error::NoSuchCell);
        }
        if predicate.value.len() > crate::table::MAX_CELL_TEXT_BYTES {
            return Err(invalid());
        }
        if matches!(
            predicate.op,
            PredicateOp::Gt | PredicateOp::Gte | PredicateOp::Lt | PredicateOp::Lte
        ) && number(&predicate.value).is_none()
        {
            return Err(invalid());
        }
        if matches!(
            predicate.op,
            PredicateOp::Empty | PredicateOp::Null | PredicateOp::Missing
        ) && !predicate.value.is_empty()
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn invalid() -> Error {
    Error::InvalidGridPredicate
}

impl Predicate {
    pub fn matches(&self, scalar: &GridScalar) -> bool {
        use PredicateOp::*;
        match self.op {
            Equals => scalar.kind == ScalarKind::Text && scalar.text == self.value,
            Contains => scalar.kind == ScalarKind::Text && scalar.text.contains(&self.value),
            Empty => scalar.kind == ScalarKind::Text && scalar.text.is_empty(),
            Null => scalar.kind == ScalarKind::Null,
            Missing => scalar.kind == ScalarKind::Missing,
            Gt | Gte | Lt | Lte => {
                if !matches!(scalar.kind, ScalarKind::Text | ScalarKind::Number) {
                    return false;
                }
                let (Some(left), Some(right)) = (number(&scalar.text), number(&self.value)) else {
                    return false;
                };
                let order = compare(left, right);
                match self.op {
                    Gt => order.is_gt(),
                    Gte => !order.is_lt(),
                    Lt => order.is_lt(),
                    Lte => !order.is_gt(),
                    _ => unreachable!(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn condition(op: PredicateOp, value: &str) -> Predicate {
        Predicate {
            column: 0,
            op,
            value: value.into(),
        }
    }
    fn cell(kind: ScalarKind, text: &str) -> GridScalar {
        GridScalar {
            kind,
            text: text.into(),
        }
    }
    #[test]
    fn empty_null_missing_and_literal_null_have_distinct_meanings() {
        let values = [
            cell(ScalarKind::Text, ""),
            cell(ScalarKind::Null, "null"),
            cell(ScalarKind::Missing, ""),
            cell(ScalarKind::Text, "null"),
        ];
        for (op, wanted) in [
            (PredicateOp::Empty, 0),
            (PredicateOp::Null, 1),
            (PredicateOp::Missing, 2),
        ] {
            for (index, value) in values.iter().enumerate() {
                assert_eq!(condition(op, "").matches(value), index == wanted);
            }
        }
        assert!(condition(PredicateOp::Equals, "null").matches(&values[3]));
        assert!(!condition(PredicateOp::Contains, "").matches(&values[1]));
    }
    #[test]
    fn numeric_comparison_requires_a_complete_finite_number() {
        let predicate = condition(PredicateOp::Lt, "-2");
        assert!(predicate.matches(&cell(ScalarKind::Number, "-2.5")));
        assert!(predicate.matches(&cell(ScalarKind::Text, " -3e0 ")));
        for value in ["", "-3x", "NaN", "-inf", "1e999"] {
            assert!(!predicate.matches(&cell(ScalarKind::Text, value)));
        }
        assert!(!condition(PredicateOp::Gt, "0").matches(&cell(ScalarKind::Boolean, "true")));
        assert!(condition(PredicateOp::Gt, "9007199254740992")
            .matches(&cell(ScalarKind::Number, "9007199254740993")));
    }
    #[test]
    fn invalid_predicates_are_rejected_before_scanning() {
        assert!(validate(&[condition(PredicateOp::Gt, "Infinity")], 1).is_err());
        assert!(validate(&[condition(PredicateOp::Null, "ignored")], 1).is_err());
        assert!(validate(&vec![condition(PredicateOp::Empty, ""); 33], 1).is_err());
        assert!(matches!(
            validate(
                &[Predicate {
                    column: 1,
                    ..condition(PredicateOp::Empty, "")
                }],
                1
            ),
            Err(Error::NoSuchCell)
        ));
    }
    #[test]
    fn text_comparison_is_exact_and_case_sensitive() {
        let scalar = cell(
            ScalarKind::Text,
            &format!("{}needle\nend", "x".repeat(2000)),
        );
        assert!(condition(PredicateOp::Contains, "needle\nend").matches(&scalar));
        assert!(!condition(PredicateOp::Contains, "NEEDLE").matches(&scalar));
        assert!(!condition(PredicateOp::Equals, "42").matches(&cell(ScalarKind::Number, "42")));
    }
}
