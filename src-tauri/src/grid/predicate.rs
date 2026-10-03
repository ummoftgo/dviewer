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

/// Accepted values remain complete finite decimal numbers. Comparison keeps the
/// written decimal exactly instead of rounding long integers or exponents to f64.
#[derive(Debug, Clone)]
struct Number {
    negative: bool,
    significant: Vec<u8>,
    exponent: Exponent,
}

/// Scientific exponents can be arbitrarily long (a tiny finite number such as
/// 1e-999999999999999999999 remains valid). Store their decimal digits rather
/// than overflowing an integer or confusing every underflow with zero.
#[derive(Debug, Clone)]
struct Exponent {
    negative: bool,
    digits: Vec<u8>,
}

fn canonical_digits(digits: &[u8]) -> Vec<u8> {
    let start = digits
        .iter()
        .position(|&digit| digit != b'0')
        .unwrap_or(digits.len());
    if start == digits.len() {
        vec![b'0']
    } else {
        digits[start..].to_vec()
    }
}

fn magnitude(left: &[u8], right: &[u8]) -> std::cmp::Ordering {
    left.len().cmp(&right.len()).then_with(|| left.cmp(right))
}

fn add_digits(left: &[u8], right: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(left.len().max(right.len()) + 1);
    let mut carry = 0;
    for at in 0..left.len().max(right.len()) {
        let a = left
            .len()
            .checked_sub(at + 1)
            .map_or(0, |index| left[index] - b'0');
        let b = right
            .len()
            .checked_sub(at + 1)
            .map_or(0, |index| right[index] - b'0');
        let sum = a + b + carry;
        result.push(b'0' + sum % 10);
        carry = sum / 10;
    }
    if carry != 0 {
        result.push(b'0' + carry);
    }
    result.reverse();
    result
}

/// left >= right, both canonical and nonnegative.
fn subtract_digits(left: &[u8], right: &[u8]) -> Vec<u8> {
    let mut result = Vec::with_capacity(left.len());
    let mut borrow = 0i16;
    for at in 0..left.len() {
        let a = i16::from(left[left.len() - at - 1] - b'0') - borrow;
        let b = right
            .len()
            .checked_sub(at + 1)
            .map_or(0, |index| i16::from(right[index] - b'0'));
        let difference = a - b;
        borrow = i16::from(difference < 0);
        result.push(
            b'0' + (if difference < 0 {
                difference + 10
            } else {
                difference
            }) as u8,
        );
    }
    result.reverse();
    canonical_digits(&result)
}

impl Exponent {
    fn new(value: &str) -> Self {
        let negative = value.starts_with('-');
        let digits = canonical_digits(value.trim_start_matches(['+', '-']).as_bytes());
        Self {
            negative: negative && digits != b"0",
            digits,
        }
    }

    fn adjusted(mut self, offset: isize) -> Self {
        if offset == 0 {
            return self;
        }
        let negative = offset < 0;
        let digits = offset.unsigned_abs().to_string().into_bytes();
        if self.negative == negative {
            self.digits = add_digits(&self.digits, &digits);
        } else {
            match magnitude(&self.digits, &digits) {
                std::cmp::Ordering::Less => {
                    self.digits = subtract_digits(&digits, &self.digits);
                    self.negative = negative;
                }
                _ => {
                    self.digits = subtract_digits(&self.digits, &digits);
                }
            }
        }
        if self.digits == b"0" {
            self.negative = false;
        }
        self
    }

    fn compare(&self, other: &Self) -> std::cmp::Ordering {
        if self.negative != other.negative {
            return other.negative.cmp(&self.negative);
        }
        let order = magnitude(&self.digits, &other.digits);
        if self.negative {
            order.reverse()
        } else {
            order
        }
    }
}

/// Match JavaScript String.trim exactly, including BOM but excluding NEL.
fn numeric_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn number(text: &str) -> Option<Number> {
    let text = text.trim_matches(numeric_whitespace);
    if text.is_empty() || !text.parse::<f64>().ok()?.is_finite() {
        return None;
    }
    let negative = text.starts_with('-');
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
        Some(at) => (&unsigned[..at], &unsigned[at + 1..]),
        None => (unsigned, "0"),
    };
    let fractional = mantissa.find('.').map_or(0, |at| mantissa.len() - at - 1);
    let digits: Vec<u8> = mantissa.bytes().filter(|&byte| byte != b'.').collect();
    // The finite f64 gate establishes grammar, so all collected bytes are digits.
    let first = digits
        .iter()
        .position(|&digit| digit != b'0')
        .unwrap_or(digits.len());
    if first == digits.len() {
        return Some(Number {
            negative: false,
            significant: Vec::new(),
            exponent: Exponent::new("0"),
        });
    }
    let offset = digits.len() as isize - fractional as isize - first as isize - 1;
    let last = digits.iter().rposition(|&digit| digit != b'0').unwrap();
    Some(Number {
        negative,
        significant: digits[first..=last].to_vec(),
        exponent: Exponent::new(exponent).adjusted(offset),
    })
}

fn compare(left: Number, right: Number) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let left_zero = left.significant.is_empty();
    let right_zero = right.significant.is_empty();
    if left_zero && right_zero {
        return Ordering::Equal;
    }
    if left_zero {
        return if right.negative {
            Ordering::Greater
        } else {
            Ordering::Less
        };
    }
    if right_zero {
        return if left.negative {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    if left.negative != right.negative {
        return right.negative.cmp(&left.negative);
    }
    let mut order = left.exponent.compare(&right.exponent);
    if order == Ordering::Equal {
        for at in 0..left.significant.len().max(right.significant.len()) {
            order = left
                .significant
                .get(at)
                .copied()
                .unwrap_or(b'0')
                .cmp(&right.significant.get(at).copied().unwrap_or(b'0'));
            if order != Ordering::Equal {
                break;
            }
        }
    }
    if left.negative {
        order.reverse()
    } else {
        order
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
    #[test]
    fn decimal_comparison_preserves_digits_beyond_binary_float_and_i128() {
        for (larger, smaller) in [
            ("9007199254740993.0", "9007199254740992"),
            (
                "170141183460469231731687303715884105729",
                "170141183460469231731687303715884105728",
            ),
            ("0.100000000000000000000000000000000000001", "0.1"),
            ("1.000000000000000000000000001e-300", "1e-300"),
            ("1e-999999999999999999998", "1e-999999999999999999999"),
            ("0", "-1e-999999999999999999999"),
        ] {
            assert!(
                condition(PredicateOp::Gt, smaller).matches(&cell(ScalarKind::Number, larger)),
                "{larger} > {smaller}"
            );
            assert!(
                condition(PredicateOp::Lt, larger).matches(&cell(ScalarKind::Text, smaller)),
                "{smaller} < {larger}"
            );
        }
        for (left, right) in [
            ("1.2300e2", "123"),
            ("-0.000e999999999999999999999", "0"),
            (".00100", "1e-3"),
            ("10e-999999999999999999999", "1e-999999999999999999998"),
        ] {
            assert!(
                condition(PredicateOp::Gte, right).matches(&cell(ScalarKind::Number, left)),
                "{left} >= {right}"
            );
            assert!(
                condition(PredicateOp::Lte, right).matches(&cell(ScalarKind::Number, left)),
                "{left} <= {right}"
            );
        }
    }

    #[test]
    fn numeric_grammar_matches_frontend_whitespace_and_rejects_partial_values() {
        for value in [
            "\u{feff}1\u{feff}",
            "\u{00a0}-.5\u{2028}",
            "1.",
            "+1e+2",
            "0e999999999999999999999",
            "1e-999999999999999999999",
        ] {
            assert!(
                validate(&[condition(PredicateOp::Gt, value)], 1).is_ok(),
                "{value:?}"
            );
        }
        for value in [
            "\u{0085}1\u{0085}",
            "0x10",
            "1_000",
            "1e2tail",
            ".",
            "1e309",
            "1 2",
        ] {
            assert!(
                matches!(
                    validate(&[condition(PredicateOp::Gt, value)], 1),
                    Err(Error::InvalidGridPredicate)
                ),
                "{value:?}"
            );
        }
    }

    #[test]
    fn long_values_and_condition_limits_preserve_entire_values() {
        let value = "😀".repeat(crate::table::MAX_CELL_TEXT_BYTES / 4);
        let predicate = condition(PredicateOp::Equals, &value);
        assert!(validate(std::slice::from_ref(&predicate), 1).is_ok());
        assert!(predicate.matches(&cell(ScalarKind::Text, &value)));
        assert!(!predicate.matches(&cell(ScalarKind::Text, &(value.clone() + "x"))));
        assert!(matches!(
            validate(&[condition(PredicateOp::Contains, &(value + "x"))], 1),
            Err(Error::InvalidGridPredicate)
        ));
        assert!(validate(&vec![condition(PredicateOp::Empty, ""); MAX_PREDICATES], 1).is_ok());
        let huge_negative_exponent = "9".repeat(10_000);
        let tiny = format!("1e-{huge_negative_exponent}");
        assert!(validate(&[condition(PredicateOp::Gt, &tiny)], 1).is_ok());
        assert!(condition(PredicateOp::Gt, "0").matches(&cell(ScalarKind::Number, &tiny)));
    }

    #[test]
    fn scalar_types_do_not_acquire_text_or_absence_meanings_from_rendering() {
        assert!(!condition(PredicateOp::Empty, "").matches(&cell(ScalarKind::Text, " ")));
        for kind in [
            ScalarKind::Boolean,
            ScalarKind::Structured,
            ScalarKind::Binary,
            ScalarKind::Null,
            ScalarKind::Missing,
        ] {
            assert!(
                !condition(PredicateOp::Gt, "0").matches(&cell(kind, "1")),
                "{kind:?}"
            );
        }
        for kind in [
            ScalarKind::Number,
            ScalarKind::Boolean,
            ScalarKind::Structured,
            ScalarKind::Binary,
        ] {
            let scalar = cell(kind, "");
            for op in [
                PredicateOp::Equals,
                PredicateOp::Contains,
                PredicateOp::Empty,
                PredicateOp::Null,
                PredicateOp::Missing,
            ] {
                assert!(!condition(op, "").matches(&scalar), "{kind:?} {op:?}");
            }
        }
    }

    #[test]
    fn decimal_normalization_agrees_with_an_integer_rational_oracle() {
        let mut seed = 17u64;
        let mut sample = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let coefficient = (seed % 2_000_001) as i128 - 1_000_000;
            let exponent = (seed / 2_000_001 % 13) as u32;
            let absolute = coefficient.unsigned_abs();
            let text = format!(
                "{}{}.{:03}e{}",
                if coefficient < 0 { "-" } else { "" },
                absolute / 1000,
                absolute % 1000,
                exponent as i32 - 6
            );
            // Every sample has the common denominator 10^9. This independent
            // bounded integer arithmetic does not use decimal normalization.
            let numerator = coefficient * 10i128.pow(exponent);
            (text, numerator)
        };
        for _ in 0..1000 {
            let (left, a) = sample();
            let (right, b) = sample();
            assert_eq!(
                compare(number(&left).unwrap(), number(&right).unwrap()),
                a.cmp(&b),
                "{left} compared with {right}"
            );
        }
    }
}
