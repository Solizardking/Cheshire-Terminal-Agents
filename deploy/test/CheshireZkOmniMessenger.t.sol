// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {CheshireZkOmniMessenger} from "../../contracts/zk-omni/CheshireZkOmniMessenger.sol";
import {MockLzEndpoint} from "../../contracts/zk-omni/MockLzEndpoint.sol";
import {MessagingFee, Origin} from "../../contracts/zk-omni/ILayerZeroEndpointV2.sol";

contract CheshireZkOmniMessengerTest is Test {
    MockLzEndpoint internal endpoint;
    CheshireZkOmniMessenger internal messengerA;
    CheshireZkOmniMessenger internal messengerB;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    uint32 internal constant EID_A = 30416; // robinhood
    uint32 internal constant EID_B = 30168; // solana stand-in

    function setUp() public {
        endpoint = new MockLzEndpoint();
        messengerA = new CheshireZkOmniMessenger(address(endpoint), address(this), address(0));
        messengerB = new CheshireZkOmniMessenger(address(endpoint), address(this), address(0));

        // Cross-wire peers as bytes32(uint160(address))
        messengerA.setPeer(EID_B, bytes32(uint256(uint160(address(messengerB)))));
        messengerB.setPeer(EID_A, bytes32(uint256(uint160(address(messengerA)))));

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    function _agentId(uint256 n) internal pure returns (bytes32) {
        return bytes32(n);
    }

    function _nullifier(bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("clawd-zk-nullifier:v1", salt));
    }

    function test_encodeRoundTripFields() public {
        bytes32 agentId = _agentId(7);
        bytes32 controller = bytes32(uint256(uint160(alice)));
        bytes32 nullifier = _nullifier(bytes32("n1"));
        bytes32 payload = keccak256("payload");
        bytes32 model = keccak256("model");
        uint64 expires = uint64(block.timestamp + 3600);

        bytes memory encoded = messengerA.encodeZkOmni(
            agentId, controller, nullifier, payload, model, expires, "attest", "memo-1"
        );

        (
            uint16 msgType,
            bytes32 a,
            bytes32 c,
            bytes32 n,
            bytes32 p,
            bytes32 m,
            uint64 exp,
            string memory action,
            string memory memo
        ) = abi.decode(
            encoded, (uint16, bytes32, bytes32, bytes32, bytes32, bytes32, uint64, string, string)
        );

        assertEq(msgType, 4);
        assertEq(a, agentId);
        assertEq(c, controller);
        assertEq(n, nullifier);
        assertEq(p, payload);
        assertEq(m, model);
        assertEq(exp, expires);
        assertEq(action, "attest");
        assertEq(memo, "memo-1");
    }

    function test_sendAndDeliverConsumesNullifier() public {
        bytes32 agentId = _agentId(42);
        bytes32 nullifier = _nullifier(bytes32("unique-1"));
        bytes32 payload = keccak256("zk-payload");
        bytes32 model = keccak256("model-hash");
        uint64 expires = uint64(block.timestamp + 7200);

        vm.prank(alice);
        messengerA.sendZkOmni{value: 0.01 ether}(
            EID_B,
            agentId,
            nullifier,
            payload,
            model,
            expires,
            "publish_attestation",
            "one-shot",
            "",
            MessagingFee({nativeFee: 0, lzTokenFee: 0})
        );

        assertTrue(messengerA.isNullifierConsumed(nullifier));

        // Deliver to B as if executor ran
        bytes memory message = messengerA.encodeZkOmni(
            agentId,
            bytes32(uint256(uint160(alice))),
            nullifier,
            payload,
            model,
            expires,
            "publish_attestation",
            "one-shot"
        );

        // Source peer on B is messengerA
        endpoint.deliver(
            address(messengerB),
            EID_A,
            bytes32(uint256(uint160(address(messengerA)))),
            keccak256("guid-1"),
            message
        );

        assertTrue(messengerB.isNullifierConsumed(nullifier));
        assertEq(messengerB.deliveredCount(), 1);
        assertEq(messengerB.lastSrcEid(), EID_A);
        assertEq(messengerB.lastGuid(), keccak256("guid-1"));

        (
            uint32 srcEid,
            ,
            bytes32 lastAgent,
            ,
            bytes32 lastNullifier,
            ,
            ,
            ,
            string memory lastAction,
        ) = messengerB.lastMessage();
        assertEq(srcEid, EID_A);
        assertEq(lastAgent, agentId);
        assertEq(lastNullifier, nullifier);
        assertEq(lastAction, "publish_attestation");
    }

    function test_nullifierReplayRejectedOnReceive() public {
        bytes32 agentId = _agentId(1);
        bytes32 nullifier = _nullifier(bytes32("replay"));
        bytes32 payload = keccak256("p");
        bytes32 model = bytes32(0);
        uint64 expires = uint64(block.timestamp + 1000);

        bytes memory message = messengerA.encodeZkOmni(
            agentId,
            bytes32(uint256(uint160(alice))),
            nullifier,
            payload,
            model,
            expires,
            "action",
            ""
        );

        endpoint.deliver(
            address(messengerB),
            EID_A,
            bytes32(uint256(uint160(address(messengerA)))),
            keccak256("g1"),
            message
        );

        vm.expectRevert(CheshireZkOmniMessenger.NullifierReplay.selector);
        endpoint.deliver(
            address(messengerB),
            EID_A,
            bytes32(uint256(uint160(address(messengerA)))),
            keccak256("g2"),
            message
        );
    }

    function test_unauthorizedPeerRejected() public {
        bytes32 agentId = _agentId(1);
        bytes32 nullifier = _nullifier(bytes32("bad-peer"));
        uint64 expires = uint64(block.timestamp + 1000);
        bytes memory message = messengerA.encodeZkOmni(
            agentId,
            bytes32(uint256(uint160(alice))),
            nullifier,
            bytes32(0),
            bytes32(0),
            expires,
            "x",
            ""
        );

        vm.expectRevert(CheshireZkOmniMessenger.UnauthorizedPeer.selector);
        endpoint.deliver(
            address(messengerB),
            EID_A,
            bytes32(uint256(uint160(address(0xDEAD)))),
            keccak256("g"),
            message
        );
    }

    function test_expiredMessageRejected() public {
        bytes32 agentId = _agentId(1);
        bytes32 nullifier = _nullifier(bytes32("expired"));
        bytes memory message = messengerA.encodeZkOmni(
            agentId,
            bytes32(uint256(uint160(alice))),
            nullifier,
            bytes32(0),
            bytes32(0),
            uint64(block.timestamp - 1),
            "x",
            ""
        );

        vm.expectRevert(CheshireZkOmniMessenger.IntentExpired.selector);
        endpoint.deliver(
            address(messengerB),
            EID_A,
            bytes32(uint256(uint160(address(messengerA)))),
            keccak256("g"),
            message
        );
    }

}
