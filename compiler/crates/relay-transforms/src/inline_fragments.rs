/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

use std::hash::Hash;
use std::sync::Arc;

use common::Location;
use fnv::FnvHashMap;
use graphql_ir::FragmentDefinition;
use graphql_ir::FragmentSpread;
use graphql_ir::InlineFragment;
use graphql_ir::Program;
use graphql_ir::ScalarField;
use graphql_ir::Selection;
use graphql_ir::Transformed;
use graphql_ir::Transformer;
use graphql_ir::node_identifier::LocationAgnosticHash;
use graphql_ir::node_identifier::LocationAgnosticPartialEq;

use crate::NoInlineFragmentSpreadMetadata;
use crate::RelayLocationAgnosticBehavior;

/// Expand fragment spreads into inline fragments containing the named
/// fragment's directives and selections. Used for constructing a Normalization
/// AST that contains all the selections that may be found in the query response.
pub fn inline_fragments(program: &Program) -> Program {
    let mut transform = InlineFragmentsTransform::new(program, true);
    transform
        .transform_program(program)
        .replace_or_else(|| program.clone())
}

pub fn inline_fragments_keep_fragments(program: &Program) -> Program {
    let mut transform = InlineFragmentsTransform::new(program, false);
    transform
        .transform_program(program)
        .replace_or_else(|| program.clone())
}

#[derive(Eq, Clone, Debug)]
struct FragmentSpreadKey(Arc<FragmentSpread>);
type Seen = FnvHashMap<FragmentSpreadKey, Arc<InlineFragment>>;

impl PartialEq for FragmentSpreadKey {
    fn eq(&self, other: &Self) -> bool {
        self.0.fragment.item == other.0.fragment.item
            && self
                .0
                .directives
                .location_agnostic_eq::<RelayLocationAgnosticBehavior>(&other.0.directives)
    }
}

impl Hash for FragmentSpreadKey {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.0.fragment.item.hash(state);
        self.0
            .directives
            .location_agnostic_hash::<_, RelayLocationAgnosticBehavior>(state);
    }
}

struct InlineFragmentsTransform<'s> {
    program: &'s Program,
    seen: Seen,
    remove_fragments: bool,
}

impl<'s> InlineFragmentsTransform<'s> {
    fn new(program: &'s Program, remove_fragments: bool) -> Self {
        Self {
            program,
            seen: Default::default(),
            remove_fragments,
        }
    }

    fn transform_fragment_spread(&mut self, spread: &Arc<FragmentSpread>) -> Arc<InlineFragment> {
        let key = FragmentSpreadKey(Arc::clone(spread));
        // If we've already created an InlineFragment for this fragment name before,
        // share it
        if let Some(prev) = self.seen.get(&key) {
            return Arc::clone(prev);
        };
        // Otherwise create the InlineFragment equivalent of the fragment (recursively
        // inlining its contents). To guard against cycles, store a dummy value
        // that we overwrite once we finish.
        self.seen.insert(
            key.clone(),
            Arc::new(InlineFragment {
                type_condition: None,
                directives: Default::default(),
                selections: Default::default(),
                spread_location: Location::generated(),
            }),
        );
        let fragment = self
            .program
            .fragment(spread.fragment.item)
            .unwrap_or_else(|| {
                panic!(
                    "Fragment spread unable to resolve fragment `{}`.",
                    spread.fragment.item
                )
            });
        let selections = self.transform_selections(&fragment.selections);
        let result = Arc::new(InlineFragment {
            type_condition: Some(fragment.type_condition),
            directives: spread.directives.clone(),
            selections: selections.replace_or_else(|| fragment.selections.clone()),
            spread_location: Location::generated(),
        });
        self.seen.insert(key, Arc::clone(&result));
        result
    }
}

impl Transformer<'_> for InlineFragmentsTransform<'_> {
    const NAME: &'static str = "InlineFragmentsTransform";
    const VISIT_ARGUMENTS: bool = false;
    const VISIT_DIRECTIVES: bool = false;

    fn transform_fragment(
        &mut self,
        fragment: &FragmentDefinition,
    ) -> Transformed<FragmentDefinition> {
        if self.remove_fragments {
            Transformed::Delete
        } else {
            self.default_transform_fragment(fragment)
        }
    }

    fn transform_selection(&mut self, selection: &Selection) -> Transformed<Selection> {
        match selection {
            Selection::FragmentSpread(selection) => {
                let should_skip_inline = selection.directives.iter().any(|directive| {
                    directive.name.item == NoInlineFragmentSpreadMetadata::directive_name()
                });
                if should_skip_inline {
                    Transformed::Keep
                } else {
                    Transformed::Replace(Selection::InlineFragment(
                        self.transform_fragment_spread(selection),
                    ))
                }
            }
            _ => self.default_transform_selection(selection),
        }
    }

    fn transform_scalar_field(&mut self, _field: &ScalarField) -> Transformed<Selection> {
        Transformed::Keep
    }
}
