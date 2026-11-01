// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Test-only tokens. Never deployed to a network.

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 v) external {
        totalSupply += v;
        balanceOf[to] += v;
        emit Transfer(address(0), to, v);
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function transfer(address to, uint256 v) public virtual returns (bool) {
        _move(msg.sender, to, v);
        return true;
    }

    function transferFrom(address f, address to, uint256 v) public virtual returns (bool) {
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        _move(f, to, v);
        return true;
    }

    function _move(address f, address to, uint256 v) internal {
        require(balanceOf[f] >= v, "balance");
        balanceOf[f] -= v;
        balanceOf[to] += v;
        emit Transfer(f, to, v);
    }
}

/// USDT-style: transfer functions return nothing.
contract NoReturnToken {
    uint256 public totalSupply = 1;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function approve(address s, uint256 v) external {
        allowance[msg.sender][s] = v;
    }

    function transfer(address to, uint256 v) external {
        require(balanceOf[msg.sender] >= v);
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
    }

    function transferFrom(address f, address to, uint256 v) external {
        require(allowance[f][msg.sender] >= v && balanceOf[f] >= v);
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
    }
}

/// Returns false instead of reverting.
contract FalseToken {
    uint256 public totalSupply = 1;

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

interface ISettlement {
    function settle(bytes32 requestId, bytes32 responseHash) external;
    function refund(bytes32 requestId, uint8 reason) external;
}

/// Calls back into the settlement during a transfer.
contract ReentrantToken is MockERC20 {
    ISettlement public target;
    bytes32 public rid;
    bool public armed;

    constructor() MockERC20("Re", "RE", 6) {}

    function arm(ISettlement t, bytes32 r) external {
        target = t;
        rid = r;
        armed = true;
    }

    function transfer(address to, uint256 v) public override returns (bool) {
        if (armed) {
            armed = false;
            target.refund(rid, 9); // try to take the money a second time
        }
        return super.transfer(to, v);
    }
}
