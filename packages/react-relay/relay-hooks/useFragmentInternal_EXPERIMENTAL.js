/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 * @oncall relay
 */

'use strict';

import type {QueryResult} from './QueryResource';
import type {
  CacheConfig,
  DataID,
  FetchPolicy,
  IEnvironment,
  ReaderFragment,
  ReaderSelector,
  SelectorData,
  Snapshot,
} from 'relay-runtime';
import type {MissingClientEdgeRequestInfo} from 'relay-runtime/store/RelayStoreTypes';

const {getQueryResourceForEnvironment} = require('./QueryResource');
const useRelayEnvironment = require('./useRelayEnvironment');
const invariant = require('invariant');
const {
  // $FlowFixMe[prop-missing] this is only available in custom builds
  experimental_useResourceEffect: useResourceEffect,
  useDebugValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} = require('react');
const {
  __internal: {fetchQuery: fetchQueryInternal, getPromiseForActiveRequest},
  RelayFeatureFlags,
  areEqualSelectors,
  createOperationDescriptor,
  getPendingOperationsForFragment,
  getSelector,
  getVariablesFromFragment,
  handlePotentialSnapshotErrors,
  recycleNodesInto,
} = require('relay-runtime');
const warning = require('warning');

export type FragmentQueryOptions = {
  fetchPolicy?: FetchPolicy,
  networkCacheConfig?: ?CacheConfig,
};

type FragmentState = $ReadOnly<
  | {kind: 'bailout', environment: IEnvironment}
  | {
      kind: 'singular',
      snapshot: Snapshot,
      epoch: number,
      selector: ReaderSelector,
      environment: IEnvironment,
    }
  | {
      kind: 'plural',
      snapshots: $ReadOnlyArray<Snapshot>,
      epoch: number,
      selector: ReaderSelector,
      environment: IEnvironment,
    },
>;

type StateUpdaterFunction<T> = ((T) => T) => void;

function isMissingData(state: FragmentState): boolean {
  if (state.kind === 'bailout') {
    return false;
  } else if (state.kind === 'singular') {
    return state.snapshot.isMissingData;
  } else {
    return state.snapshots.some(s => s.isMissingData);
  }
}

function getMissingClientEdges(
  state: FragmentState,
): $ReadOnlyArray<MissingClientEdgeRequestInfo> | null {
  if (state.kind === 'bailout') {
    return null;
  } else if (state.kind === 'singular') {
    return state.snapshot.missingClientEdges ?? null;
  } else {
    let edges: null | Array<MissingClientEdgeRequestInfo> = null;
    for (const snapshot of state.snapshots) {
      if (snapshot.missingClientEdges) {
        edges = edges ?? [];
        for (const edge of snapshot.missingClientEdges) {
          edges.push(edge);
        }
      }
    }
    return edges;
  }
}

function getSuspendingLiveResolver(
  state: FragmentState,
): $ReadOnlyArray<DataID> | null {
  if (state.kind === 'bailout') {
    return null;
  } else if (state.kind === 'singular') {
    return state.snapshot.missingLiveResolverFields ?? null;
  } else {
    let missingFields: null | Array<DataID> = null;
    for (const snapshot of state.snapshots) {
      if (snapshot.missingLiveResolverFields) {
        missingFields = missingFields ?? [];
        for (const edge of snapshot.missingLiveResolverFields) {
          missingFields.push(edge);
        }
      }
    }
    return missingFields;
  }
}

function handlePotentialSnapshotErrorsForState(
  environment: IEnvironment,
  state: FragmentState,
): void {
  if (state.kind === 'singular') {
    handlePotentialSnapshotErrors(environment, state.snapshot.fieldErrors);
  } else if (state.kind === 'plural') {
    for (const snapshot of state.snapshots) {
      handlePotentialSnapshotErrors(environment, snapshot.fieldErrors);
    }
  }
}

/**
 * Check for updates to the store that occurred concurrently with rendering the given `state` value,
 * returning a new (updated) state if there were updates or null if there were no changes.
 */
function handleMissedUpdates(
  environment: IEnvironment,
  state: FragmentState,
): null | [/* has data changed */ boolean, FragmentState] {
  if (state.kind === 'bailout') {
    return null;
  }
  // FIXME this is invalid if we've just switched environments.
  const currentEpoch = environment.getStore().getEpoch();
  if (currentEpoch === state.epoch) {
    return null;
  }
  // The store has updated since we rendered (without us being subscribed yet),
  // so check for any updates to the data we're rendering:
  if (state.kind === 'singular') {
    const currentSnapshot = environment.lookup(state.snapshot.selector);
    const updatedData = recycleNodesInto(
      state.snapshot.data,
      currentSnapshot.data,
    );
    const updatedCurrentSnapshot: Snapshot = {
      data: updatedData,
      isMissingData: currentSnapshot.isMissingData,
      missingClientEdges: currentSnapshot.missingClientEdges,
      missingLiveResolverFields: currentSnapshot.missingLiveResolverFields,
      seenRecords: currentSnapshot.seenRecords,
      selector: currentSnapshot.selector,
      fieldErrors: currentSnapshot.fieldErrors,
    };
    return [
      updatedData !== state.snapshot.data,
      {
        kind: 'singular',
        snapshot: updatedCurrentSnapshot,
        epoch: currentEpoch,
        selector: state.selector,
        environment: state.environment,
      },
    ];
  } else {
    let didMissUpdates = false;
    const currentSnapshots = [];
    for (let index = 0; index < state.snapshots.length; index++) {
      const snapshot = state.snapshots[index];
      const currentSnapshot = environment.lookup(snapshot.selector);
      const updatedData = recycleNodesInto(snapshot.data, currentSnapshot.data);
      const updatedCurrentSnapshot: Snapshot = {
        data: updatedData,
        isMissingData: currentSnapshot.isMissingData,
        missingClientEdges: currentSnapshot.missingClientEdges,
        missingLiveResolverFields: currentSnapshot.missingLiveResolverFields,
        seenRecords: currentSnapshot.seenRecords,
        selector: currentSnapshot.selector,
        fieldErrors: currentSnapshot.fieldErrors,
      };
      if (updatedData !== snapshot.data) {
        didMissUpdates = true;
      }
      currentSnapshots.push(updatedCurrentSnapshot);
    }
    invariant(
      currentSnapshots.length === state.snapshots.length,
      'Expected same number of snapshots',
    );
    return [
      didMissUpdates,
      {
        kind: 'plural',
        snapshots: currentSnapshots,
        epoch: currentEpoch,
        selector: state.selector,
        environment: state.environment,
      },
    ];
  }
}

function handleMissingClientEdge(
  environment: IEnvironment,
  parentFragmentNode: ReaderFragment,
  parentFragmentRef: mixed,
  missingClientEdgeRequestInfo: MissingClientEdgeRequestInfo,
  queryOptions?: FragmentQueryOptions,
): [QueryResult, ?Promise<mixed>] {
  const originalVariables = getVariablesFromFragment(
    parentFragmentNode,
    parentFragmentRef,
  );
  const variables = {
    ...originalVariables,
    id: missingClientEdgeRequestInfo.clientEdgeDestinationID, // TODO should be a reserved name
  };
  const queryOperationDescriptor = createOperationDescriptor(
    missingClientEdgeRequestInfo.request,
    variables,
    queryOptions?.networkCacheConfig,
  );
  // This may suspend. We don't need to do anything with the results; all we're
  // doing here is started the query if needed and retaining and releasing it
  // according to the component mount/suspense cycle; QueryResource
  // already handles this by itself.
  const QueryResource = getQueryResourceForEnvironment(environment);
  const queryResult = QueryResource.prepare(
    queryOperationDescriptor,
    fetchQueryInternal(environment, queryOperationDescriptor),
    queryOptions?.fetchPolicy,
  );

  return [
    queryResult,
    getPromiseForActiveRequest(environment, queryOperationDescriptor.request),
  ];
}

function subscribeToSnapshot(
  environment: IEnvironment,
  state: FragmentState,
  setState: StateUpdaterFunction<FragmentState>,
): () => void {
  if (state.kind === 'bailout') {
    return () => {};
  } else if (state.kind === 'singular') {
    const disposable = environment.subscribe(state.snapshot, latestSnapshot => {
      setState(prevState => {
        // In theory a setState from a subscription could be batched together
        // with a setState to change the fragment selector. Guard against this
        // by bailing out of the state update if the selector has changed.
        let nextState: FragmentState | null = null;
        if (
          prevState.kind !== 'singular' ||
          prevState.snapshot.selector !== latestSnapshot.selector ||
          prevState.environment !== environment
        ) {
          const updates = handleMissedUpdates(prevState.environment, prevState);
          if (updates != null) {
            const [dataChanged, updatedState] = updates;
            environment.__log({
              name: 'useFragment.subscription.missedUpdates',
              hasDataChanges: dataChanged,
            });
            nextState = dataChanged ? updatedState : prevState;
          } else {
            nextState = prevState;
          }
        } else {
          nextState = {
            kind: 'singular',
            snapshot: latestSnapshot,
            epoch: environment.getStore().getEpoch(),
            selector: state.selector,
            environment: state.environment,
          };
        }
        return nextState;
      });
    });
    return () => {
      disposable.dispose();
    };
  } else {
    const disposables = state.snapshots.map((snapshot, index) =>
      environment.subscribe(snapshot, latestSnapshot => {
        setState(prevState => {
          // In theory a setState from a subscription could be batched together
          // with a setState to change the fragment selector. Guard against this
          // by bailing out of the state update if the selector has changed.
          let nextState: FragmentState | null = null;
          if (
            prevState.kind !== 'plural' ||
            prevState.snapshots[index]?.selector !== latestSnapshot.selector ||
            prevState.environment !== environment
          ) {
            const updates = handleMissedUpdates(
              prevState.environment,
              prevState,
            );
            if (updates != null) {
              const [dataChanged, updatedState] = updates;
              environment.__log({
                name: 'useFragment.subscription.missedUpdates',
                hasDataChanges: dataChanged,
              });
              nextState = dataChanged ? updatedState : prevState;
            } else {
              nextState = prevState;
            }
          } else {
            const updated = [...prevState.snapshots];
            updated[index] = latestSnapshot;
            nextState = {
              kind: 'plural',
              snapshots: updated,
              epoch: environment.getStore().getEpoch(),
              selector: state.selector,
              environment: state.environment,
            };
          }
          return nextState;
        });
      }),
    );
    return () => {
      for (const d of disposables) {
        d.dispose();
      }
    };
  }
}

function getFragmentState(
  environment: IEnvironment,
  fragmentSelector: ?ReaderSelector,
): FragmentState {
  if (fragmentSelector == null) {
    return {kind: 'bailout', environment};
  } else if (fragmentSelector.kind === 'PluralReaderSelector') {
    // Note that if fragmentRef is an empty array, fragmentSelector will be null so we'll hit the above case.
    // Null is returned by getSelector if fragmentRef has no non-null items.
    return {
      kind: 'plural',
      snapshots: fragmentSelector.selectors.map(s => environment.lookup(s)),
      epoch: environment.getStore().getEpoch(),
      selector: fragmentSelector,
      environment: environment,
    };
  } else {
    return {
      kind: 'singular',
      snapshot: environment.lookup(fragmentSelector),
      epoch: environment.getStore().getEpoch(),
      selector: fragmentSelector,
      environment: environment,
    };
  }
}

// fragmentNode cannot change during the lifetime of the component, though fragmentRef may change.
hook useFragmentInternal_EXPERIMENTAL(
  fragmentNode: ReaderFragment,
  fragmentRef: mixed,
  hookDisplayName: string,
  queryOptions?: FragmentQueryOptions,
): ?SelectorData | Array<?SelectorData> {
  const fragmentSelector = useMemo(
    () => getSelector(fragmentNode, fragmentRef),
    [fragmentNode, fragmentRef],
  );

  const isPlural = fragmentNode?.metadata?.plural === true;

  if (isPlural) {
    invariant(
      fragmentRef == null || Array.isArray(fragmentRef),
      'Relay: Expected fragment pointer%s for fragment `%s` to be ' +
        'an array, instead got `%s`. Remove `@relay(plural: true)` ' +
        'from fragment `%s` to allow the prop to be an object.',
      fragmentNode.name,
      typeof fragmentRef,
      fragmentNode.name,
    );
  } else {
    invariant(
      !Array.isArray(fragmentRef),
      'Relay: Expected fragment pointer%s for fragment `%s` not to be ' +
        'an array, instead got `%s`. Add `@relay(plural: true)` ' +
        'to fragment `%s` to allow the prop to be an array.',
      fragmentNode.name,
      typeof fragmentRef,
      fragmentNode.name,
    );
  }
  invariant(
    fragmentRef == null ||
      (isPlural && Array.isArray(fragmentRef) && fragmentRef.length === 0) ||
      fragmentSelector != null,
    'Relay: Expected to receive an object where `...%s` was spread, ' +
      'but the fragment reference was not found`. This is most ' +
      'likely the result of:\n' +
      "- Forgetting to spread `%s` in `%s`'s parent's fragment.\n" +
      '- Conditionally fetching `%s` but unconditionally passing %s prop ' +
      'to `%s`. If the parent fragment only fetches the fragment conditionally ' +
      '- with e.g. `@include`, `@skip`, or inside a `... on SomeType { }` ' +
      'spread  - then the fragment reference will not exist. ' +
      'In this case, pass `null` if the conditions for evaluating the ' +
      'fragment are not met (e.g. if the `@include(if)` value is false.)',
    fragmentNode.name,
    fragmentNode.name,
    hookDisplayName,
    fragmentNode.name,
    hookDisplayName,
  );

  const environment = useRelayEnvironment();
  const [_state, setState] = useState<FragmentState>(() =>
    getFragmentState(environment, fragmentSelector),
  );
  let state = _state;
  const previousEnvironment = state.environment;

  if (
    !areEqualSelectors(fragmentSelector, state.selector) ||
    environment !== state.environment
  ) {
    // Enqueue setState to record the new selector and state
    const newState = getFragmentState(environment, fragmentSelector);
    setState(newState);
    // But render with the latest state w/o waiting for the setState. Otherwise
    // the component would render the wrong information temporarily (including
    // possibly incorrectly triggering some warnings below).
    state = newState;
  }

  // The purpose of this is to detect whether we have ever committed, because we
  // don't suspend on store updates, only when the component either is first trying
  // to mount or when the our selector changes. The selector change in particular is
  // how we suspend for pagination and refetch. Also, fragment selector can be null
  // or undefined, so we use false as a special value to distinguish from all fragment
  // selectors; false means that the component hasn't mounted yet.
  const committedFragmentSelectorRef = useRef<false | ?ReaderSelector>(false);
  useEffect(() => {
    committedFragmentSelectorRef.current = fragmentSelector;
  }, [fragmentSelector]);

  // Handle the queries for any missing client edges; this may suspend.
  // FIXME handle client edges in parallel.
  if (fragmentNode.metadata?.hasClientEdges === true) {
    // The fragment is validated to be static (in useFragment) and hasClientEdges is
    // a static (constant) property of the fragment. In practice, this effect will
    // always or never run for a given invocation of this hook.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // $FlowFixMe[react-rule-hook]
    const [clientEdgeQueries, activeRequestPromises] = useMemo(() => {
      const missingClientEdges = getMissingClientEdges(state);
      // eslint-disable-next-line no-shadow
      let clientEdgeQueries;
      const activeRequestPromises = [];
      if (missingClientEdges?.length) {
        clientEdgeQueries = ([]: Array<QueryResult>);
        for (const edge of missingClientEdges) {
          const [queryResult, requestPromise] = handleMissingClientEdge(
            environment,
            fragmentNode,
            fragmentRef,
            edge,
            queryOptions,
          );
          clientEdgeQueries.push(queryResult);
          if (requestPromise != null) {
            activeRequestPromises.push(requestPromise);
          }
        }
      }
      return [clientEdgeQueries, activeRequestPromises];
    }, [state, environment, fragmentNode, fragmentRef, queryOptions]);

    if (activeRequestPromises.length) {
      throw Promise.all(activeRequestPromises);
    }

    // See above note
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // $FlowFixMe[react-rule-hook]
    useEffect(() => {
      const QueryResource = getQueryResourceForEnvironment(environment);
      if (clientEdgeQueries?.length) {
        const disposables = [];
        for (const query of clientEdgeQueries) {
          disposables.push(QueryResource.retain(query));
        }
        return () => {
          for (const disposable of disposables) {
            disposable.dispose();
          }
        };
      }
    }, [environment, clientEdgeQueries]);
  }

  if (isMissingData(state)) {
    // Suspend if a Live Resolver within this fragment is in a suspended state:
    const suspendingLiveResolvers = getSuspendingLiveResolver(state);
    if (suspendingLiveResolvers != null && suspendingLiveResolvers.length > 0) {
      throw Promise.all(
        suspendingLiveResolvers.map(liveStateID => {
          // $FlowFixMe[prop-missing] This is expected to be a RelayModernStore
          return environment.getStore().getLiveResolverPromise(liveStateID);
        }),
      );
    }
    // Suspend if an active operation bears on this fragment, either the
    // fragment's owner or some other mutation etc. that could affect it.
    // We only suspend when the component is first trying to mount or changing
    // selectors, not if data becomes missing later:
    if (
      RelayFeatureFlags.ENABLE_RELAY_OPERATION_TRACKER_SUSPENSE ||
      environment !== previousEnvironment ||
      !committedFragmentSelectorRef.current ||
      // $FlowFixMe[react-rule-unsafe-ref]
      !areEqualSelectors(committedFragmentSelectorRef.current, fragmentSelector)
    ) {
      invariant(fragmentSelector != null, 'refinement, see invariants above');
      const fragmentOwner =
        fragmentSelector.kind === 'PluralReaderSelector'
          ? fragmentSelector.selectors[0].owner
          : fragmentSelector.owner;
      const pendingOperationsResult = getPendingOperationsForFragment(
        environment,
        fragmentNode,
        fragmentOwner,
      );
      if (pendingOperationsResult) {
        throw pendingOperationsResult.promise;
      }
    }
  }

  // Report required fields only if we're not suspending, since that means
  // they're missing even though we are out of options for possibly fetching them:
  handlePotentialSnapshotErrorsForState(environment, state);

  // We emulate CRUD effects using a ref and two effects:
  // - The ref tracks the current state (including updates from the subscription)
  //   and the dispose function for the current subscription. This is null until
  //   a subscription is established.
  // - The first effect is the "update" effect, and re-runs when the environment
  //   or state changes. It is responsible for disposing of the previous subscription
  //   and establishing a new one, but it manualy reconciles the current state
  //   with the subscribed state and bails out if it is already subscribed to the
  //   correct (current) state.
  // - The second effect is the mount/unmount (and attach/reattach effect). It
  //   makes sure that the subscription is disposed when the component unmounts
  //   or detaches (<Activity> going hidden), and then re-subscribes when the component
  //   re-attaches (<Activity> going visible). These cases wouldn't fire the
  //   "update" effect because the state and environment don't change.
  const storeSubscriptionRef = useRef<{
    dispose: () => void,
    selector: ?ReaderSelector,
    environment: IEnvironment,
  } | null>(null);

  if (
    RelayFeatureFlags.ENABLE_RESOURCE_EFFECTS &&
    typeof useResourceEffect === 'function'
  ) {
    // $FlowExpectedError[react-rule-hook] - the condition is static
    useResourceEffect(
      () => {
        return {
          dispose:
            state.kind !== 'bailout'
              ? subscribeToSnapshot(state.environment, state, setState)
              : () => {},
          selector: state.selector,
          environment: state.environment,
        };
      },
      // NOTE: this intentionally has no dependencies
      [],
      // $FlowFixMe[missing-local-annot] - Untyped in OSS
      storeSubscription => {
        if (
          state.environment === storeSubscription.environment &&
          state.selector === storeSubscription.selector
        ) {
          // We're already subscribed to the same selector, so no need to do anything
          return;
        } else {
          // The selector has changed, so we need to dispose of the previous subscription
          storeSubscription.dispose();
        }
        if (state.kind === 'bailout') {
          return;
        }
        // The FragmentState that we'll actually subscribe to. Note that it's possible that
        // a concurrent modification to the store didn't affect the snapshot _data_ (so we don't
        // need to re-render), but did affect the seen records. So if there were missed updates
        // we use that state to subscribe.
        let stateForSubscription: FragmentState = state;
        // No subscription yet or the selector has changed, so we need to subscribe
        // first check for updates since the state was rendered
        const updates = handleMissedUpdates(state.environment, state);
        if (updates !== null) {
          const [didMissUpdates, updatedState] = updates;
          // TODO: didMissUpdates only checks for changes to snapshot data, but it's possible
          // that other snapshot properties may have changed that should also trigger a re-render,
          // such as changed missing resolver fields, missing client edges, etc.
          // A potential alternative is for handleMissedUpdates() to recycle the entire state
          // value, and return the new (recycled) state only if there was some change. In that
          // case the code would always setState if something in the snapshot changed, in addition
          // to using the latest snapshot to subscribe.
          if (didMissUpdates) {
            setState(updatedState);
            // We missed updates, we're going to render again anyway so wait until then to subscribe
            return;
          }
          stateForSubscription = updatedState;
        }
        const dispose = subscribeToSnapshot(
          state.environment,
          stateForSubscription,
          setState,
        );
        storeSubscription.dispose = dispose;
        storeSubscription.selector = state.selector;
        storeSubscription.environment = state.environment;
      },
      [state],
      // $FlowFixMe[missing-local-annot] - Untyped in OSS
      storeSubscription => {
        storeSubscription.dispose();
      },
    );
  } else {
    // $FlowFixMe[react-rule-hook] - the condition is static
    useEffect(() => {
      const storeSubscription = storeSubscriptionRef.current;
      if (storeSubscription != null) {
        if (
          state.environment === storeSubscription.environment &&
          state.selector === storeSubscription.selector
        ) {
          // We're already subscribed to the same selector, so no need to do anything
          return;
        } else {
          // The selector has changed, so we need to dispose of the previous subscription
          storeSubscription.dispose();
        }
      }
      if (state.kind === 'bailout') {
        return;
      }
      // The FragmentState that we'll actually subscribe to. Note that it's possible that
      // a concurrent modification to the store didn't affect the snapshot _data_ (so we don't
      // need to re-render), but did affect the seen records. So if there were missed updates
      // we use that state to subscribe.
      let stateForSubscription: FragmentState = state;
      // No subscription yet or the selector has changed, so we need to subscribe
      // first check for updates since the state was rendered
      const updates = handleMissedUpdates(state.environment, state);
      if (updates !== null) {
        const [didMissUpdates, updatedState] = updates;
        // TODO: didMissUpdates only checks for changes to snapshot data, but it's possible
        // that other snapshot properties may have changed that should also trigger a re-render,
        // such as changed missing resolver fields, missing client edges, etc.
        // A potential alternative is for handleMissedUpdates() to recycle the entire state
        // value, and return the new (recycled) state only if there was some change. In that
        // case the code would always setState if something in the snapshot changed, in addition
        // to using the latest snapshot to subscribe.
        if (didMissUpdates) {
          setState(updatedState);
          // We missed updates, we're going to render again anyway so wait until then to subscribe
          return;
        }
        stateForSubscription = updatedState;
      }
      const dispose = subscribeToSnapshot(
        state.environment,
        stateForSubscription,
        setState,
      );
      storeSubscriptionRef.current = {
        dispose,
        selector: state.selector,
        environment: state.environment,
      };
    }, [state]);
    // $FlowFixMe[react-rule-hook] - the condition is static
    useEffect(() => {
      if (storeSubscriptionRef.current == null && state.kind !== 'bailout') {
        const dispose = subscribeToSnapshot(state.environment, state, setState);
        storeSubscriptionRef.current = {
          dispose,
          selector: state.selector,
          environment: state.environment,
        };
      }
      return () => {
        storeSubscriptionRef.current?.dispose();
        storeSubscriptionRef.current = null;
      };
      // NOTE: this intentionally has no dependencies, see above comment about
      // simulating a CRUD effect
    }, []);
  }

  let data: ?SelectorData | Array<?SelectorData>;
  if (isPlural) {
    // Plural fragments require allocating an array of the snapshot data values,
    // which has to be memoized to avoid triggering downstream re-renders.
    //
    // Note that isPlural is a constant property of the fragment and does not change
    // for a particular useFragment invocation site
    const fragmentRefIsNullish = fragmentRef == null; // for less sensitive memoization
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // $FlowFixMe[react-rule-hook]
    data = useMemo(() => {
      if (state.kind === 'bailout') {
        // Bailout state can happen if the fragmentRef is a plural array that is empty or has no
        // non-null entries. In that case, the compatible behavior is to return [] instead of null.
        return fragmentRefIsNullish ? null : [];
      } else {
        invariant(
          state.kind === 'plural',
          'Expected state to be plural because fragment is plural',
        );
        return state.snapshots.map(s => s.data);
      }
    }, [state, fragmentRefIsNullish]);
  } else if (state.kind === 'bailout') {
    // This case doesn't allocate a new object so it doesn't have to be memoized
    data = null;
  } else {
    // This case doesn't allocate a new object so it doesn't have to be memoized
    invariant(
      state.kind === 'singular',
      'Expected state to be singular because fragment is singular',
    );
    data = state.snapshot.data;
  }

  if (RelayFeatureFlags.LOG_MISSING_RECORDS_IN_PROD || __DEV__) {
    if (
      fragmentRef != null &&
      (data === undefined ||
        (Array.isArray(data) &&
          data.length > 0 &&
          data.every(d => d === undefined)))
    ) {
      warning(
        false,
        'Relay: Expected to have been able to read non-null data for ' +
          'fragment `%s` declared in ' +
          '`%s`, since fragment reference was non-null. ' +
          "Make sure that that `%s`'s parent isn't " +
          'holding on to and/or passing a fragment reference for data that ' +
          'has been deleted.',
        fragmentNode.name,
        hookDisplayName,
        hookDisplayName,
      );
    }
  }

  if (__DEV__) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    // $FlowFixMe[react-rule-hook]
    useDebugValue({fragment: fragmentNode.name, data});
  }

  return data;
}

module.exports = useFragmentInternal_EXPERIMENTAL;
