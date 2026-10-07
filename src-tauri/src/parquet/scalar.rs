//! Source scalars for export/filtering. Display strings are not JSON serialization.
use crate::error::{Error, Result, Subject};
use crate::grid::{GridScalar, ScalarKind};
use crate::table::MAX_CELL_TEXT_BYTES;
use num_bigint::BigInt;
use parquet::data_type::Decimal;
use parquet::record::Field;

const MAX_DEPTH: u32 = 128;
// Converting a multi-megabyte unscaled BigInt to base 10 is expensive even if
// its final text fits the cell cap. Bound this conversion separately.
const MAX_DECIMAL_DIGITS: usize = 4096;
fn too_large() -> Error {
    Error::TooLarge {
        subject: Subject::Table,
        megabytes: MAX_CELL_TEXT_BYTES / (1024 * 1024) + 1,
        limit_mb: MAX_CELL_TEXT_BYTES / (1024 * 1024),
    }
}
fn invalid(detail: &str) -> Error {
    Error::ParseFailed {
        subject: Subject::Table,
        detail: detail.to_owned(),
    }
}

/// At most one scalar's permitted output is built, including JSON escaping.
struct Text {
    value: String,
}
impl Text {
    fn push(&mut self, value: &str) -> Result<()> {
        if self.value.len().saturating_add(value.len()) > MAX_CELL_TEXT_BYTES {
            return Err(too_large());
        }
        self.value.push_str(value);
        Ok(())
    }
    fn quoted(&mut self, value: &str) -> Result<()> {
        self.push("\"")?;
        let mut start = 0;
        for (at, character) in value.char_indices() {
            let escape = match character {
                '"' => Some("\\\""),
                '\\' => Some("\\\\"),
                '\n' => Some("\\n"),
                '\r' => Some("\\r"),
                '\t' => Some("\\t"),
                '\u{8}' => Some("\\b"),
                '\u{c}' => Some("\\f"),
                _ => None,
            };
            if let Some(escape) = escape {
                self.push(&value[start..at])?;
                self.push(escape)?;
                start = at + character.len_utf8();
            } else if character <= '\u{1f}' {
                self.push(&value[start..at])?;
                self.push(&format!("\\u{:04x}", character as u32))?;
                start = at + character.len_utf8();
            }
        }
        self.push(&value[start..])?;
        self.push("\"")
    }
    fn decimal(&mut self, decimal: &Decimal) -> Result<()> {
        if decimal.precision() <= 0 || decimal.scale() < 0 || decimal.scale() > decimal.precision()
        {
            return Err(invalid("Invalid Parquet decimal precision or scale."));
        }
        let scale = decimal.scale() as usize;
        // Bound the digit buffer before BigInt's conversion and the zero padding
        // before allocation. The estimate is conservative (log10(2) rounded up).
        let digit_bound = decimal
            .data()
            .len()
            .saturating_mul(8)
            .saturating_mul(30103)
            .div_ceil(100000)
            .saturating_add(2);
        if digit_bound > MAX_DECIMAL_DIGITS {
            return Err(invalid("Parquet decimal conversion exceeds 4096 digits."));
        }
        let integer = BigInt::from_signed_bytes_be(decimal.data()).to_str_radix(10);
        let (negative, digits) = integer
            .strip_prefix('-')
            .map_or((false, integer.as_str()), |digits| (true, digits));
        if digits.len() > decimal.precision() as usize {
            return Err(invalid("Parquet decimal exceeds its declared precision."));
        }
        // A large scale changes the exponent, not the unscaled integer. Emit
        // its exact JSON number without constructing millions of zero bytes.
        if scale > MAX_DECIMAL_DIGITS {
            self.push(&integer)?;
            self.push("e-")?;
            return self.push(&scale.to_string());
        }
        if negative {
            self.push("-")?;
        }
        if scale == 0 {
            return self.push(digits);
        }
        if digits.len() > scale {
            let split = digits.len() - scale;
            self.push(&digits[..split])?;
            self.push(".")?;
            self.push(&digits[split..])
        } else {
            self.push("0.")?;
            let mut zeros = scale - digits.len();
            const ZEROES: &str = "0000000000000000000000000000000000000000000000000000000000000000";
            while zeros > 0 {
                let count = zeros.min(ZEROES.len());
                self.push(&ZEROES[..count])?;
                zeros -= count;
            }
            self.push(digits)
        }
    }
    fn list(&mut self, elements: &[Field], depth: u32) -> Result<()> {
        self.push("[")?;
        for (at, value) in elements.iter().enumerate() {
            if at > 0 {
                self.push(",")?;
            }
            self.nested(value, depth + 1)?;
        }
        self.push("]")
    }
    fn map(&mut self, entries: &[(Field, Field)], depth: u32) -> Result<()> {
        self.push("[")?;
        for (at, (key, value)) in entries.iter().enumerate() {
            if at > 0 {
                self.push(",")?;
            }
            self.push("[")?;
            self.nested(key, depth + 2)?;
            self.push(",")?;
            self.nested(value, depth + 2)?;
            self.push("]")?;
        }
        self.push("]")
    }
    fn nested(&mut self, field: &Field, depth: u32) -> Result<()> {
        if depth >= MAX_DEPTH {
            return Err(Error::TooDeep {
                subject: Subject::Table,
                limit: MAX_DEPTH,
            });
        }
        match field {
            Field::Null => self.push("null"),
            Field::Str(value) => self.quoted(value),
            Field::Bytes(value) => {
                let length = value.data().len().saturating_mul(2).saturating_add(5);
                if length > MAX_CELL_TEXT_BYTES.saturating_sub(self.value.len()) {
                    return Err(too_large());
                }
                self.quoted(&crate::grid::hex_cell(value.data(), false).0)
            }
            Field::Group(row) => {
                self.push("{")?;
                for (at, (name, value)) in row.get_column_iter().enumerate() {
                    if at > 0 {
                        self.push(",")?;
                    }
                    self.quoted(name)?;
                    self.push(":")?;
                    self.nested(value, depth + 1)?;
                }
                self.push("}")
            }
            Field::ListInternal(list) => self.list(list.elements(), depth),
            // A Parquet map can have typed keys and repeated entries. Pair arrays
            // preserve both, whereas converting it to a JSON object cannot.
            Field::MapInternal(map) => self.map(map.entries(), depth),
            Field::Decimal(decimal) => self.decimal(decimal),
            Field::Float(value) if !value.is_finite() => Err(invalid(
                "Non-finite Parquet numbers cannot be represented as JSON.",
            )),
            Field::Double(value) if !value.is_finite() => Err(invalid(
                "Non-finite Parquet numbers cannot be represented as JSON.",
            )),
            Field::Float16(value) if !value.is_finite() => Err(invalid(
                "Non-finite Parquet numbers cannot be represented as JSON.",
            )),
            Field::Bool(_)
            | Field::Byte(_)
            | Field::Short(_)
            | Field::Int(_)
            | Field::Long(_)
            | Field::UByte(_)
            | Field::UShort(_)
            | Field::UInt(_)
            | Field::ULong(_)
            | Field::Float(_)
            | Field::Double(_)
            | Field::Float16(_) => self.push(&super::full_text(field)),
            _ => self.quoted(&super::full_text(field)),
        }
    }
}

pub(super) fn read(field: &Field) -> Result<GridScalar> {
    let kind = match field {
        Field::Null => ScalarKind::Null,
        Field::Str(_) => ScalarKind::Text,
        Field::Bool(_) => ScalarKind::Boolean,
        Field::Bytes(_) => ScalarKind::Binary,
        Field::Group(_) | Field::ListInternal(_) | Field::MapInternal(_) => ScalarKind::Structured,
        Field::Byte(_)
        | Field::Short(_)
        | Field::Int(_)
        | Field::Long(_)
        | Field::UByte(_)
        | Field::UShort(_)
        | Field::UInt(_)
        | Field::ULong(_)
        | Field::Float(_)
        | Field::Double(_)
        | Field::Float16(_)
        | Field::Decimal(_) => ScalarKind::Number,
        _ => ScalarKind::Text,
    };
    let mut text = Text {
        value: String::new(),
    };
    match field {
        Field::Group(_) | Field::ListInternal(_) | Field::MapInternal(_) => {
            text.nested(field, 0)?
        }
        Field::Decimal(decimal) => text.decimal(decimal)?,
        Field::Str(value) => text.push(value)?,
        Field::Bytes(value) => {
            if value.data().len().saturating_mul(2).saturating_add(3) > MAX_CELL_TEXT_BYTES {
                return Err(too_large());
            }
            text.push(&crate::grid::hex_cell(value.data(), false).0)?;
        }
        _ => text.push(&super::full_text(field))?,
    }
    Ok(GridScalar {
        text: text.value,
        kind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use parquet::data_type::ByteArray;
    use parquet::record::Row;
    // The crate's List/Map constructors are private, so test the slice writers
    // used by the production Field arms instead of assuming exported helpers.
    fn list(elements: &[Field]) -> Result<String> {
        let mut text = Text {
            value: String::new(),
        };
        text.list(elements, 0)?;
        Ok(text.value)
    }
    fn map(entries: &[(Field, Field)]) -> Result<String> {
        let mut text = Text {
            value: String::new(),
        };
        text.map(entries, 0)?;
        Ok(text.value)
    }
    #[test]
    fn source_structure_uses_json_escapes_and_exact_number_tokens() {
        let field = Field::Group(Row::new(vec![
            (
                "name\u{1b}".into(),
                Field::Str("line\n\0\u{8}\\\"😀".into()),
            ),
            ("large".into(), Field::ULong(9007199254740993)),
            (
                "decimal".into(),
                Field::Decimal(Decimal::from_i64(1234567890123456789, 19, 9)),
            ),
        ]));
        let scalar = read(&field).unwrap();
        assert_eq!(scalar.text,"{\"name\\u001b\":\"line\\n\\u0000\\b\\\\\\\"😀\",\"large\":9007199254740993,\"decimal\":1234567890.123456789}");
        serde_json::from_str::<serde::de::IgnoredAny>(&scalar.text).unwrap();
    }
    #[test]
    fn maps_preserve_key_types_duplicate_entries_and_order() {
        let entries = vec![
            (Field::Int(1), Field::Str("a".into())),
            (Field::Int(1), Field::Null),
            (Field::Str("1".into()), Field::Bool(true)),
        ];
        assert_eq!(map(&entries).unwrap(), "[[1,\"a\"],[1,null],[\"1\",true]]");
    }
    #[test]
    fn scalar_decimal_scale_zero_equal_precision_and_invalid_metadata() {
        assert_eq!(
            read(&Field::Decimal(Decimal::from_i32(4, 8, 0)))
                .unwrap()
                .text,
            "4"
        );
        assert_eq!(
            read(&Field::Decimal(Decimal::from_i32(-4, 2, 2)))
                .unwrap()
                .text,
            "-0.04"
        );
        assert!(matches!(
            read(&Field::Decimal(Decimal::from_i32(4, 1, 2))),
            Err(Error::ParseFailed { .. })
        ));
        let tiny = read(&Field::Decimal(Decimal::from_i32(4, i32::MAX, i32::MAX))).unwrap();
        assert_eq!(tiny.text, "4e-2147483647");
        serde_json::from_str::<serde::de::IgnoredAny>(&tiny.text).unwrap();
        let too_many_digits = Field::Decimal(Decimal::from_bytes(
            ByteArray::from(vec![1; MAX_DECIMAL_DIGITS / 2]),
            i32::MAX,
            0,
        ));
        assert!(matches!(
            read(&too_many_digits),
            Err(Error::ParseFailed { .. })
        ));
    }
    #[test]
    fn output_ceiling_precedes_escaping_and_binary_expansion() {
        assert!(matches!(
            read(&Field::Str("x".repeat(MAX_CELL_TEXT_BYTES + 1))),
            Err(Error::TooLarge { .. })
        ));
        let escaped = vec![Field::Str("\0".repeat(MAX_CELL_TEXT_BYTES / 6))];
        assert!(matches!(list(&escaped), Err(Error::TooLarge { .. })));
        let binary = Field::Bytes(ByteArray::from(vec![0; MAX_CELL_TEXT_BYTES / 2]));
        assert!(matches!(read(&binary), Err(Error::TooLarge { .. })));
        let mut text = Text {
            value: String::new(),
        };
        assert!(matches!(
            text.list(&escaped, 0),
            Err(Error::TooLarge { .. })
        ));
        assert!(text.value.len() <= MAX_CELL_TEXT_BYTES);
    }
    #[test]
    fn byte_backed_decimal_and_nested_binary_date_values_keep_their_meaning() {
        let bytes = BigInt::parse_bytes(b"18446744073709551617", 10)
            .unwrap()
            .to_signed_bytes_be();
        let decimal = Field::Decimal(Decimal::from_bytes(ByteArray::from(bytes), 20, 0));
        assert_eq!(read(&decimal).unwrap().text, "18446744073709551617");
        let fields = vec![
            Field::Bytes(ByteArray::from(vec![1, 2])),
            Field::TimestampMillis(0),
            Field::Null,
        ];
        assert_eq!(
            list(&fields).unwrap(),
            "[\"x'0102'\",\"1970-01-01T00:00:00\",null]"
        );
    }
    #[test]
    fn nested_scalar_stops_at_the_byte_and_depth_boundaries() {
        let exact = vec![Field::Str("x".repeat(MAX_CELL_TEXT_BYTES - 4))];
        assert_eq!(list(&exact).unwrap().len(), MAX_CELL_TEXT_BYTES);
        let too_big = vec![Field::Str("x".repeat(MAX_CELL_TEXT_BYTES - 3))];
        assert!(matches!(list(&too_big), Err(Error::TooLarge { .. })));
        let mut deep = Field::Int(1);
        for _ in 0..MAX_DEPTH {
            deep = Field::Group(Row::new(vec![("child".into(), deep)]));
        }
        assert!(matches!(
            read(&deep),
            Err(Error::TooDeep {
                limit: MAX_DEPTH,
                ..
            })
        ));
    }
    #[test]
    fn non_finite_nested_numbers_are_explicitly_rejected() {
        let fields = vec![Field::Double(f64::INFINITY)];
        assert!(matches!(list(&fields), Err(Error::ParseFailed { .. })));
    }
}
