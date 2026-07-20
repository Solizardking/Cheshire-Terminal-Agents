// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {
    ILayerZeroEndpointV2,
    ILayerZeroReceiver,
    MessagingFee,
    MessagingParams,
    MessagingReceipt,
    Origin
} from "./ILayerZeroEndpointV2.sol";

/**
 * @title CheshireZkOmniMessenger
 * @notice Zero-knowledge omnichain messenger for Robinhood Chain ↔ Solana.
 * @dev Message type 4 carries a domain-separated nullifier for anti-replay.
 *      LayerZero authenticates the remote peer; this contract enforces:
 *        - peer allowlist
 *        - nullifier uniqueness (consumedNullifier)
 *        - expiry
 *        - optional agent identity authorization on send
 *
 *      Payload layout (abi.encode):
 *        uint16  msgType            // = 4
 *        bytes32 agentId
 *        bytes32 controller
 *        bytes32 nullifier
 *        bytes32 payloadCommitment
 *        bytes32 modelHash
 *        uint64  expiresAt
 *        string  action
 *        string  memo
 */
contract CheshireZkOmniMessenger is ILayerZeroReceiver {
    uint16 public constant MSG_ZK_OMNI = 4;
    uint32 public constant SOLANA_EID = 30168;
    uint32 public constant ROBINHOOD_EID = 30416;
    uint256 public constant MAX_ACTION_LENGTH = 64;
    uint256 public constant MAX_MEMO_LENGTH = 200;

    ILayerZeroEndpointV2 public immutable endpoint;
    address public owner;

    /// @dev Optional identity registry with isAuthorized(operator, agentId).
    address public identityRegistry;

    mapping(uint32 eid => bytes32 peer) public peers;
    mapping(bytes32 nullifier => bool consumed) public consumedNullifier;

    struct ZkOmniMessage {
        uint32 srcEid;
        bytes32 guid;
        bytes32 agentId;
        bytes32 controller;
        bytes32 nullifier;
        bytes32 payloadCommitment;
        bytes32 modelHash;
        uint64 expiresAt;
        string action;
        string memo;
    }

    ZkOmniMessage public lastMessage;
    bytes32 public lastGuid;
    uint32 public lastSrcEid;
    uint256 public deliveredCount;

    event PeerSet(uint32 indexed eid, bytes32 peer);
    event IdentityRegistrySet(address indexed registry);
    event ZkOmniSent(
        uint32 indexed dstEid,
        bytes32 indexed guid,
        bytes32 indexed nullifier,
        bytes32 agentId,
        address controller,
        bytes32 payloadCommitment,
        string action
    );
    event ZkOmniReceived(
        uint32 indexed srcEid,
        bytes32 indexed guid,
        bytes32 indexed nullifier,
        bytes32 agentId,
        bytes32 controller,
        bytes32 payloadCommitment,
        string action
    );

    error NotOwner();
    error InvalidEndpoint();
    error InvalidPeer();
    error UnauthorizedPeer();
    error UnauthorizedAgent();
    error InvalidNullifier();
    error NullifierReplay();
    error IntentExpired();
    error InvalidMessageType();
    error IntentTextTooLong();
    error InvalidAgentId();
    error InvalidController();
    error FeeTooLow();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _endpoint, address _owner, address _identityRegistry) {
        if (_endpoint == address(0) || _endpoint.code.length == 0) revert InvalidEndpoint();
        endpoint = ILayerZeroEndpointV2(_endpoint);
        owner = _owner == address(0) ? msg.sender : _owner;
        identityRegistry = _identityRegistry;
    }

    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        if (peer == bytes32(0)) revert InvalidPeer();
        peers[eid] = peer;
        emit PeerSet(eid, peer);
    }

    function setIdentityRegistry(address registry) external onlyOwner {
        identityRegistry = registry;
        emit IdentityRegistrySet(registry);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner");
        owner = newOwner;
    }

    function encodeZkOmni(
        bytes32 agentId,
        bytes32 controller,
        bytes32 nullifier,
        bytes32 payloadCommitment,
        bytes32 modelHash,
        uint64 expiresAt,
        string calldata action,
        string calldata memo
    ) external pure returns (bytes memory) {
        return _encode(
            agentId, controller, nullifier, payloadCommitment, modelHash, expiresAt, action, memo
        );
    }

    function quoteSend(
        uint32 dstEid,
        bytes32 agentId,
        bytes32 nullifier,
        bytes32 payloadCommitment,
        bytes32 modelHash,
        uint64 expiresAt,
        string calldata action,
        string calldata memo,
        bytes calldata options,
        bool payInLzToken
    ) external view returns (MessagingFee memory) {
        _assertSendable(agentId, nullifier, expiresAt, action, memo);
        bytes32 peer = peers[dstEid];
        if (peer == bytes32(0)) revert InvalidPeer();
        bytes memory message = _encode(
            agentId,
            bytes32(uint256(uint160(msg.sender))),
            nullifier,
            payloadCommitment,
            modelHash,
            expiresAt,
            action,
            memo
        );
        return endpoint.quote(
            MessagingParams({
                dstEid: dstEid,
                receiver: peer,
                message: message,
                options: options,
                payInLzToken: payInLzToken
            }),
            address(this)
        );
    }

    function sendZkOmni(
        uint32 dstEid,
        bytes32 agentId,
        bytes32 nullifier,
        bytes32 payloadCommitment,
        bytes32 modelHash,
        uint64 expiresAt,
        string calldata action,
        string calldata memo,
        bytes calldata options,
        MessagingFee calldata /* fee */
    ) external payable returns (MessagingReceipt memory receipt) {
        _assertSendable(agentId, nullifier, expiresAt, action, memo);
        bytes32 peer = peers[dstEid];
        if (peer == bytes32(0)) revert InvalidPeer();

        // Consume nullifier on source to prevent double-send of the same proof.
        if (consumedNullifier[nullifier]) revert NullifierReplay();
        consumedNullifier[nullifier] = true;

        bytes memory message = _encode(
            agentId,
            bytes32(uint256(uint160(msg.sender))),
            nullifier,
            payloadCommitment,
            modelHash,
            expiresAt,
            action,
            memo
        );

        receipt = endpoint.send{value: msg.value}(
            MessagingParams({
                dstEid: dstEid,
                receiver: peer,
                message: message,
                options: options,
                payInLzToken: false
            }),
            msg.sender
        );

        emit ZkOmniSent(
            dstEid, receipt.guid, nullifier, agentId, msg.sender, payloadCommitment, action
        );
    }

    /// @inheritdoc ILayerZeroReceiver
    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address,
        bytes calldata
    ) external payable {
        if (msg.sender != address(endpoint)) revert UnauthorizedPeer();
        bytes32 expectedPeer = peers[origin.srcEid];
        if (expectedPeer == bytes32(0) || expectedPeer != origin.sender) revert UnauthorizedPeer();

        (
            uint16 msgType,
            bytes32 agentId,
            bytes32 controller,
            bytes32 nullifier,
            bytes32 payloadCommitment,
            bytes32 modelHash,
            uint64 expiresAt,
            string memory action,
            string memory memo
        ) = abi.decode(
            message, (uint16, bytes32, bytes32, bytes32, bytes32, bytes32, uint64, string, string)
        );

        if (msgType != MSG_ZK_OMNI) revert InvalidMessageType();
        if (agentId == bytes32(0)) revert InvalidAgentId();
        if (controller == bytes32(0)) revert InvalidController();
        if (nullifier == bytes32(0)) revert InvalidNullifier();
        if (expiresAt <= block.timestamp) revert IntentExpired();
        if (bytes(action).length > MAX_ACTION_LENGTH || bytes(memo).length > MAX_MEMO_LENGTH) {
            revert IntentTextTooLong();
        }
        if (consumedNullifier[nullifier]) revert NullifierReplay();
        consumedNullifier[nullifier] = true;

        lastGuid = guid;
        lastSrcEid = origin.srcEid;
        lastMessage = ZkOmniMessage({
            srcEid: origin.srcEid,
            guid: guid,
            agentId: agentId,
            controller: controller,
            nullifier: nullifier,
            payloadCommitment: payloadCommitment,
            modelHash: modelHash,
            expiresAt: expiresAt,
            action: action,
            memo: memo
        });
        deliveredCount += 1;

        emit ZkOmniReceived(
            origin.srcEid, guid, nullifier, agentId, controller, payloadCommitment, action
        );
    }

    function allowInitializePath(Origin calldata origin) external view returns (bool) {
        return peers[origin.srcEid] == origin.sender && origin.sender != bytes32(0);
    }

    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0; // unordered delivery; nullifier is the replay key
    }

    function isNullifierConsumed(bytes32 nullifier) external view returns (bool) {
        return consumedNullifier[nullifier];
    }

    // -------- internals --------

    function _assertSendable(
        bytes32 agentId,
        bytes32 nullifier,
        uint64 expiresAt,
        string calldata action,
        string calldata memo
    ) internal view {
        if (agentId == bytes32(0)) revert InvalidAgentId();
        if (nullifier == bytes32(0)) revert InvalidNullifier();
        if (expiresAt <= block.timestamp) revert IntentExpired();
        if (bytes(action).length > MAX_ACTION_LENGTH || bytes(memo).length > MAX_MEMO_LENGTH) {
            revert IntentTextTooLong();
        }
        if (identityRegistry != address(0)) {
            (bool ok, bytes memory ret) = identityRegistry.staticcall(
                abi.encodeWithSignature("isAuthorized(address,uint256)", msg.sender, uint256(agentId))
            );
            if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) revert UnauthorizedAgent();
        }
    }

    function _encode(
        bytes32 agentId,
        bytes32 controller,
        bytes32 nullifier,
        bytes32 payloadCommitment,
        bytes32 modelHash,
        uint64 expiresAt,
        string memory action,
        string memory memo
    ) internal pure returns (bytes memory) {
        return abi.encode(
            MSG_ZK_OMNI,
            agentId,
            controller,
            nullifier,
            payloadCommitment,
            modelHash,
            expiresAt,
            action,
            memo
        );
    }
}
