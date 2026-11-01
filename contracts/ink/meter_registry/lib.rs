#![cfg_attr(not(feature = "std"), no_std, no_main)]

//! # Portal Meter registry (ink! 5, pallet-contracts / WASM)
//!
//! The WASM half of Portal Meter. Payments are escrowed and settled by `MeterSettlement` on Portaldot's
//! EVM (pallet-revive); this contract keeps the public, per-provider record of what happened to them:
//!
//! * providers list their endpoints here (the HTTP URL buyers discover),
//! * providers anchor the outcome of each paid request (served or refunded, amount, receipt hash),
//! * buyers confirm or dispute a served request. The contract recomputes the EVM request id from the
//!   caller's own address, so only the account that paid on the EVM side can give feedback on it.
//!
//! ## One identity on both VMs
//! Every account is namespaced by the address it has inside pallet-revive (`h160_of`): an Ethereum key's
//! twin account `H160 ++ 0xEE * 12` maps back to that `H160`, any other account to
//! `keccak256(account_id)[12..]`. A provider writes under the same address that registered its endpoint in
//! `MeterSettlement`; nobody can write into another provider's namespace. With `revive.ethSubstrateCall`
//! a provider can send `utility.batchAll([revive.call(settle), contracts.call(record)])` from its Ethereum
//! key, so the EVM settlement and this record land atomically in one transaction.

#[ink::contract]
mod meter_registry {
    use ink::prelude::vec::Vec;
    use ink::storage::Mapping;

    /// An address as seen inside pallet-revive (the EVM).
    pub type H160 = [u8; 20];
    pub type Hash32 = [u8; 32];

    pub const OUTCOME_SERVED: u8 = 1;
    pub const OUTCOME_REFUNDED: u8 = 2;
    pub const FEEDBACK_NONE: u8 = 0;
    pub const FEEDBACK_CONFIRMED: u8 = 1;
    pub const FEEDBACK_DISPUTED: u8 = 2;
    /// Longest endpoint URL accepted, in bytes (keeps the storage deposit small).
    pub const MAX_URI_LEN: usize = 96;

    #[derive(Debug, Clone, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    #[cfg_attr(feature = "std", derive(ink::storage::traits::StorageLayout))]
    pub struct EndpointRecord {
        /// HTTPS URL of the endpoint, UTF-8.
        pub uri: Vec<u8>,
        pub served: u64,
        pub refunded: u64,
        pub confirmed: u64,
        pub disputed: u64,
        /// Sum of served amounts in token base units, as anchored by the provider.
        pub volume: u128,
        pub registered_at: BlockNumber,
        pub last_activity: BlockNumber,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    #[cfg_attr(feature = "std", derive(ink::storage::traits::StorageLayout))]
    pub struct Anchor {
        pub endpoint_id: u32,
        pub outcome: u8,
        pub amount: u128,
        /// keccak256 of the signed receipt the seller returned (or of the refund reason).
        pub receipt_hash: Hash32,
        pub block: BlockNumber,
        pub feedback: u8,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    pub struct Reputation {
        pub served: u64,
        pub refunded: u64,
        pub confirmed: u64,
        pub disputed: u64,
        /// (served - disputed) / (served + refunded) in basis points; 0 when there is no history.
        pub score_bps: u16,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    #[ink::scale_derive(Encode, Decode, TypeInfo)]
    pub enum Error {
        UriTooLong,
        UriEmpty,
        AlreadyRegistered,
        NotRegistered,
        AlreadyAnchored,
        BadOutcome,
        NoSuchAnchor,
        NotServed,
        AlreadyRated,
        ZeroRequestId,
    }

    pub type Result<T> = core::result::Result<T, Error>;

    #[ink(event)]
    pub struct EndpointListed {
        #[ink(topic)]
        provider: H160,
        #[ink(topic)]
        endpoint_id: u32,
        uri: Vec<u8>,
    }

    #[ink(event)]
    pub struct OutcomeAnchored {
        #[ink(topic)]
        provider: H160,
        #[ink(topic)]
        request_id: Hash32,
        endpoint_id: u32,
        outcome: u8,
        amount: u128,
        receipt_hash: Hash32,
    }

    #[ink(event)]
    pub struct FeedbackGiven {
        #[ink(topic)]
        provider: H160,
        #[ink(topic)]
        request_id: Hash32,
        payer: H160,
        feedback: u8,
    }

    #[ink(storage)]
    pub struct MeterRegistry {
        /// `MeterSettlement` on the EVM side and the EVM chain id: the inputs of the request id.
        settlement: H160,
        evm_chain_id: u64,
        endpoints: Mapping<(H160, u32), EndpointRecord>,
        anchors: Mapping<(H160, Hash32), Anchor>,
        endpoint_count: u32,
        anchor_count: u64,
    }

    impl MeterRegistry {
        #[ink(constructor)]
        pub fn new(settlement: H160, evm_chain_id: u64) -> Self {
            Self {
                settlement,
                evm_chain_id,
                endpoints: Mapping::default(),
                anchors: Mapping::default(),
                endpoint_count: 0,
                anchor_count: 0,
            }
        }

        // ------------------------------------------------------------ provider

        /// List endpoint `endpoint_id` of the caller's namespace (the id it has in `MeterSettlement`).
        #[ink(message)]
        pub fn register_endpoint(&mut self, endpoint_id: u32, uri: Vec<u8>) -> Result<()> {
            check_uri(&uri)?;
            let me = self.whoami();
            if self.endpoints.contains((me, endpoint_id)) {
                return Err(Error::AlreadyRegistered);
            }
            let now = self.env().block_number();
            self.endpoints.insert(
                (me, endpoint_id),
                &EndpointRecord {
                    uri: uri.clone(),
                    served: 0,
                    refunded: 0,
                    confirmed: 0,
                    disputed: 0,
                    volume: 0,
                    registered_at: now,
                    last_activity: now,
                },
            );
            self.endpoint_count = self.endpoint_count.saturating_add(1);
            self.env().emit_event(EndpointListed { provider: me, endpoint_id, uri });
            Ok(())
        }

        /// Change the URL of one of the caller's endpoints.
        #[ink(message)]
        pub fn set_uri(&mut self, endpoint_id: u32, uri: Vec<u8>) -> Result<()> {
            check_uri(&uri)?;
            let me = self.whoami();
            let mut rec = self.endpoints.get((me, endpoint_id)).ok_or(Error::NotRegistered)?;
            rec.uri = uri.clone();
            self.endpoints.insert((me, endpoint_id), &rec);
            self.env().emit_event(EndpointListed { provider: me, endpoint_id, uri });
            Ok(())
        }

        /// Anchor the final outcome of one paid request, once.
        #[ink(message)]
        pub fn record(
            &mut self,
            endpoint_id: u32,
            request_id: Hash32,
            outcome: u8,
            amount: u128,
            receipt_hash: Hash32,
        ) -> Result<()> {
            if request_id == [0u8; 32] {
                return Err(Error::ZeroRequestId);
            }
            if outcome != OUTCOME_SERVED && outcome != OUTCOME_REFUNDED {
                return Err(Error::BadOutcome);
            }
            let me = self.whoami();
            let mut rec = self.endpoints.get((me, endpoint_id)).ok_or(Error::NotRegistered)?;
            if self.anchors.contains((me, request_id)) {
                return Err(Error::AlreadyAnchored);
            }
            let now = self.env().block_number();
            if outcome == OUTCOME_SERVED {
                rec.served = rec.served.saturating_add(1);
                rec.volume = rec.volume.saturating_add(amount);
            } else {
                rec.refunded = rec.refunded.saturating_add(1);
            }
            rec.last_activity = now;
            self.endpoints.insert((me, endpoint_id), &rec);
            self.anchors.insert(
                (me, request_id),
                &Anchor { endpoint_id, outcome, amount, receipt_hash, block: now, feedback: FEEDBACK_NONE },
            );
            self.anchor_count = self.anchor_count.saturating_add(1);
            self.env().emit_event(OutcomeAnchored { provider: me, request_id, endpoint_id, outcome, amount, receipt_hash });
            Ok(())
        }

        // ------------------------------------------------------------ buyer

        /// Confirm (`ok = true`) or dispute a served request. The request id is recomputed from the
        /// caller's address and `nonce`, exactly as `MeterSettlement.requestIdFor` does, so only the payer
        /// can rate it, once.
        #[ink(message)]
        pub fn rate(&mut self, provider: H160, endpoint_id: u32, nonce: Hash32, ok: bool) -> Result<()> {
            let payer = self.whoami();
            let request_id = self.request_id_for(payer, endpoint_id, nonce);
            let mut a = self.anchors.get((provider, request_id)).ok_or(Error::NoSuchAnchor)?;
            if a.endpoint_id != endpoint_id || a.outcome != OUTCOME_SERVED {
                return Err(Error::NotServed);
            }
            if a.feedback != FEEDBACK_NONE {
                return Err(Error::AlreadyRated);
            }
            let mut rec = self.endpoints.get((provider, endpoint_id)).ok_or(Error::NotRegistered)?;
            a.feedback = if ok { FEEDBACK_CONFIRMED } else { FEEDBACK_DISPUTED };
            if ok {
                rec.confirmed = rec.confirmed.saturating_add(1);
            } else {
                rec.disputed = rec.disputed.saturating_add(1);
            }
            self.anchors.insert((provider, request_id), &a);
            self.endpoints.insert((provider, endpoint_id), &rec);
            self.env().emit_event(FeedbackGiven { provider, request_id, payer, feedback: a.feedback });
            Ok(())
        }

        // ------------------------------------------------------------ views

        /// `keccak256(abi.encode(uint256 chainId, address settlement, address payer, uint32 endpointId, bytes32 nonce))`,
        /// identical to `MeterSettlement.requestIdFor`.
        #[ink(message)]
        pub fn request_id_for(&self, payer: H160, endpoint_id: u32, nonce: Hash32) -> Hash32 {
            let mut buf = [0u8; 160];
            buf[24..32].copy_from_slice(&self.evm_chain_id.to_be_bytes());
            buf[44..64].copy_from_slice(&self.settlement);
            buf[76..96].copy_from_slice(&payer);
            buf[124..128].copy_from_slice(&endpoint_id.to_be_bytes());
            buf[128..160].copy_from_slice(&nonce);
            let mut out = [0u8; 32];
            ink::env::hash_bytes::<ink::env::hash::Keccak256>(&buf, &mut out);
            out
        }

        /// The EVM address the caller acts as (its namespace here).
        #[ink(message)]
        pub fn whoami(&self) -> H160 {
            h160_of(&self.env().caller())
        }

        #[ink(message)]
        pub fn endpoint(&self, provider: H160, endpoint_id: u32) -> Option<EndpointRecord> {
            self.endpoints.get((provider, endpoint_id))
        }

        #[ink(message)]
        pub fn anchor(&self, provider: H160, request_id: Hash32) -> Option<Anchor> {
            self.anchors.get((provider, request_id))
        }

        #[ink(message)]
        pub fn reputation(&self, provider: H160, endpoint_id: u32) -> Reputation {
            match self.endpoints.get((provider, endpoint_id)) {
                None => Reputation { served: 0, refunded: 0, confirmed: 0, disputed: 0, score_bps: 0 },
                Some(r) => {
                    let total = u128::from(r.served).saturating_add(u128::from(r.refunded));
                    let good = u128::from(r.served.saturating_sub(r.disputed));
                    let score = if total == 0 { 0 } else { good.saturating_mul(10_000) / total };
                    Reputation {
                        served: r.served,
                        refunded: r.refunded,
                        confirmed: r.confirmed,
                        disputed: r.disputed,
                        score_bps: u16::try_from(score).unwrap_or(10_000),
                    }
                }
            }
        }

        /// (settlement contract, EVM chain id, endpoints listed, outcomes anchored)
        #[ink(message)]
        pub fn info(&self) -> (H160, u64, u32, u64) {
            (self.settlement, self.evm_chain_id, self.endpoint_count, self.anchor_count)
        }
    }

    fn check_uri(uri: &[u8]) -> Result<()> {
        if uri.is_empty() {
            return Err(Error::UriEmpty);
        }
        if uri.len() > MAX_URI_LEN {
            return Err(Error::UriTooLong);
        }
        Ok(())
    }

    /// pallet-revive's AccountId32 -> H160 mapping.
    pub fn h160_of(account: &AccountId) -> H160 {
        let bytes: &[u8; 32] = account.as_ref();
        let mut out = [0u8; 20];
        if bytes[20..].iter().all(|b| *b == 0xEE) {
            out.copy_from_slice(&bytes[..20]);
        } else {
            let mut hash = [0u8; 32];
            ink::env::hash_bytes::<ink::env::hash::Keccak256>(bytes, &mut hash);
            out.copy_from_slice(&hash[12..]);
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use ink::env::{test, DefaultEnvironment};

        const SETTLEMENT: H160 = [0x5e, 0x77, 0xee, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01];
        const CHAIN: u64 = 420_420_777;

        fn h(s: &str) -> Vec<u8> {
            (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
        }

        fn arr20(v: &[u8]) -> H160 {
            let mut a = [0u8; 20];
            a.copy_from_slice(v);
            a
        }

        /// Ethereum key twin account: H160 ++ 0xEE * 12
        fn twin(h160: H160) -> AccountId {
            let mut a = [0xEEu8; 32];
            a[..20].copy_from_slice(&h160);
            AccountId::from(a)
        }

        fn as_caller(a: AccountId) {
            test::set_caller::<DefaultEnvironment>(a);
        }

        const PROVIDER: H160 = [0x43; 20];
        const BUYER: H160 = [0xB0; 20];

        fn deployed() -> MeterRegistry {
            MeterRegistry::new(SETTLEMENT, CHAIN)
        }

        #[ink::test]
        fn request_id_matches_solidity_vector() {
            // same vector as the Solidity and JS tests
            let r = deployed();
            let payer = arr20(&h("0118d896dc979963341e9449218e63e158cb6aba"));
            let nonce = [0xabu8; 32];
            let id = r.request_id_for(payer, 1, nonce);
            assert_eq!(id.to_vec(), h("2aa9da812dcbc42abb80854df02c687e70b72bce5d18979ce95bc8d00372fcbd"));
        }

        #[ink::test]
        fn h160_mapping_both_kinds() {
            let p = arr20(&h("77df5a7c0375be0a492c109ccafb96551fa8ca5c"));
            assert_eq!(h160_of(&twin(p)), p);
            // sr25519 account 5ETkpnDAeRU46becz38vSSP42vWoBnzZ2e4FFRbG6W3hVBdC, checked against ReviveApi_address
            let mut raw = [0u8; 32];
            raw.copy_from_slice(&h("6a0d19ba716eef2ba5b0f24401860aa1e8e85a60182dfe04f031475af6039031"));
            assert_eq!(h160_of(&AccountId::from(raw)).to_vec(), h("299b95378937b7735dd0b11f3446c01fd00281bf"));
        }

        #[ink::test]
        fn provider_lists_and_records() {
            let mut r = deployed();
            as_caller(twin(PROVIDER));
            assert_eq!(r.whoami(), PROVIDER);
            assert_eq!(r.register_endpoint(1, b"https://meter.example/v1/x".to_vec()), Ok(()));
            assert_eq!(r.register_endpoint(1, b"https://dup".to_vec()), Err(Error::AlreadyRegistered));
            let rid = r.request_id_for(BUYER, 1, [1u8; 32]);
            assert_eq!(r.record(1, rid, OUTCOME_SERVED, 25_000, [9u8; 32]), Ok(()));
            assert_eq!(r.record(1, rid, OUTCOME_SERVED, 25_000, [9u8; 32]), Err(Error::AlreadyAnchored));
            let rid2 = r.request_id_for(BUYER, 1, [2u8; 32]);
            assert_eq!(r.record(1, rid2, OUTCOME_REFUNDED, 25_000, [8u8; 32]), Ok(()));
            let rep = r.reputation(PROVIDER, 1);
            assert_eq!((rep.served, rep.refunded, rep.score_bps), (1, 1, 5_000));
            let e = r.endpoint(PROVIDER, 1).unwrap();
            assert_eq!(e.volume, 25_000);
            assert_eq!(r.anchor(PROVIDER, rid).unwrap().outcome, OUTCOME_SERVED);
            assert_eq!(r.info(), (SETTLEMENT, CHAIN, 1, 2));
        }

        #[ink::test]
        fn record_guards() {
            let mut r = deployed();
            as_caller(twin(PROVIDER));
            assert_eq!(r.record(1, [1u8; 32], OUTCOME_SERVED, 1, [0u8; 32]), Err(Error::NotRegistered));
            r.register_endpoint(1, b"https://a".to_vec()).unwrap();
            assert_eq!(r.record(1, [0u8; 32], OUTCOME_SERVED, 1, [0u8; 32]), Err(Error::ZeroRequestId));
            assert_eq!(r.record(1, [1u8; 32], 3, 1, [0u8; 32]), Err(Error::BadOutcome));
            assert_eq!(r.register_endpoint(2, Vec::new()), Err(Error::UriEmpty));
            assert_eq!(r.register_endpoint(2, [b'a'; MAX_URI_LEN + 1].to_vec()), Err(Error::UriTooLong));
        }

        #[ink::test]
        fn namespaces_are_isolated() {
            let mut r = deployed();
            as_caller(twin(PROVIDER));
            r.register_endpoint(1, b"https://a".to_vec()).unwrap();
            // another account cannot record into PROVIDER's endpoint 1: it writes in its own namespace
            as_caller(twin([0x66; 20]));
            assert_eq!(r.record(1, [1u8; 32], OUTCOME_SERVED, 1, [0u8; 32]), Err(Error::NotRegistered));
            assert_eq!(r.set_uri(1, b"https://evil".to_vec()), Err(Error::NotRegistered));
            assert_eq!(r.endpoint(PROVIDER, 1).unwrap().uri, b"https://a".to_vec());
        }

        #[ink::test]
        fn only_the_payer_can_rate_once() {
            let mut r = deployed();
            as_caller(twin(PROVIDER));
            r.register_endpoint(1, b"https://a".to_vec()).unwrap();
            let nonce = [7u8; 32];
            let rid = r.request_id_for(BUYER, 1, nonce);
            r.record(1, rid, OUTCOME_SERVED, 10, [1u8; 32]).unwrap();
            // a stranger computing with its own address gets a different id
            as_caller(twin([0x99; 20]));
            assert_eq!(r.rate(PROVIDER, 1, nonce, false), Err(Error::NoSuchAnchor));
            as_caller(twin(BUYER));
            assert_eq!(r.rate(PROVIDER, 1, nonce, false), Ok(()));
            assert_eq!(r.rate(PROVIDER, 1, nonce, true), Err(Error::AlreadyRated));
            let rep = r.reputation(PROVIDER, 1);
            assert_eq!((rep.served, rep.disputed, rep.score_bps), (1, 1, 0));
            assert_eq!(r.anchor(PROVIDER, rid).unwrap().feedback, FEEDBACK_DISPUTED);
        }

        #[ink::test]
        fn refunded_requests_cannot_be_rated() {
            let mut r = deployed();
            as_caller(twin(PROVIDER));
            r.register_endpoint(1, b"https://a".to_vec()).unwrap();
            let nonce = [3u8; 32];
            let rid = r.request_id_for(BUYER, 1, nonce);
            r.record(1, rid, OUTCOME_REFUNDED, 10, [1u8; 32]).unwrap();
            as_caller(twin(BUYER));
            assert_eq!(r.rate(PROVIDER, 1, nonce, true), Err(Error::NotServed));
        }

        #[ink::test]
        fn empty_reputation_is_zero() {
            let r = deployed();
            assert_eq!(r.reputation(PROVIDER, 5).score_bps, 0);
            assert!(r.endpoint(PROVIDER, 5).is_none());
        }
    }
}
