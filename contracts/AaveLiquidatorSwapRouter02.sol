// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IAavePoolMinimal {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

interface ISwapRouter02Minimal {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function factory() external view returns (address);

    function WETH9() external view returns (address);

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV3FactoryMinimal {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

contract AaveLiquidatorSwapRouter02 {
    IAavePoolMinimal public immutable aavePool;
    IAavePoolMinimal public immutable POOL;
    ISwapRouter02Minimal public immutable netSwapRouter;
    address public owner;
    uint256 public slippageTolerance = 0;

    uint24[] private commonFeeTiers;
    address[] private intermediateTokens;
    mapping(address => mapping(address => uint24)) public preferredFeeTier;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PreferredFeeTierSet(address indexed tokenIn, address indexed tokenOut, uint24 fee);
    event CommonFeeTiersSet(uint24[] feeTiers);
    event IntermediateTokensSet(address[] tokens);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _aavePool, address _swapRouter02) {
        require(_aavePool != address(0), "pool is zero");
        require(_swapRouter02 != address(0), "router is zero");

        owner = msg.sender;
        aavePool = IAavePoolMinimal(_aavePool);
        POOL = IAavePoolMinimal(_aavePool);
        netSwapRouter = ISwapRouter02Minimal(_swapRouter02);

        commonFeeTiers.push(100);
        commonFeeTiers.push(500);
        commonFeeTiers.push(3000);
        commonFeeTiers.push(10000);

        address wrappedNative = ISwapRouter02Minimal(_swapRouter02).WETH9();
        if (wrappedNative != address(0)) {
            intermediateTokens.push(wrappedNative);
        }

        emit OwnershipTransferred(address(0), msg.sender);
    }

    function triggerLiquidation(
        address debtAsset,
        uint256 debtAmount,
        address targetUser,
        address collateralAsset
    ) external onlyOwner {
        require(debtAsset != address(0), "debt is zero");
        require(collateralAsset != address(0), "collateral is zero");
        require(targetUser != address(0), "user is zero");
        require(debtAmount > 0, "debt amount is zero");

        bytes memory params = abi.encode(targetUser, collateralAsset);
        aavePool.flashLoanSimple(address(this), debtAsset, debtAmount, params, 0);
    }

    function executeOperation(
        address debtAsset,
        uint256 debtAmount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(aavePool), "caller is not pool");
        require(initiator == address(this), "bad initiator");

        (address targetUser, address collateralAsset) = abi.decode(params, (address, address));
        _safeApprove(debtAsset, address(aavePool), debtAmount);
        aavePool.liquidationCall(collateralAsset, debtAsset, targetUser, debtAmount, false);

        uint256 amountOwed = debtAmount + premium;
        uint256 debtBalance = IERC20Minimal(debtAsset).balanceOf(address(this));

        if (debtBalance < amountOwed && collateralAsset != debtAsset) {
            uint256 collateralBalance = IERC20Minimal(collateralAsset).balanceOf(address(this));
            require(collateralBalance > 0, "no collateral received");

            _safeApprove(collateralAsset, address(netSwapRouter), collateralBalance);
            bytes memory path = _resolveSwapPath(collateralAsset, debtAsset);
            netSwapRouter.exactInput(
                ISwapRouter02Minimal.ExactInputParams({
                    path: path,
                    recipient: address(this),
                    amountIn: collateralBalance,
                    amountOutMinimum: amountOwed - debtBalance
                })
            );

            debtBalance = IERC20Minimal(debtAsset).balanceOf(address(this));
        }

        require(debtBalance >= amountOwed, "insufficient debt asset");
        _safeApprove(debtAsset, address(aavePool), amountOwed);
        return true;
    }

    function setPreferredFeeTier(address tokenIn, address tokenOut, uint24 fee) external onlyOwner {
        require(tokenIn != address(0), "tokenIn is zero");
        require(tokenOut != address(0), "tokenOut is zero");
        preferredFeeTier[tokenIn][tokenOut] = fee;
        emit PreferredFeeTierSet(tokenIn, tokenOut, fee);
    }

    function setCommonFeeTiers(uint24[] calldata feeTiers) external onlyOwner {
        require(feeTiers.length > 0, "empty fee tiers");
        delete commonFeeTiers;
        for (uint256 i = 0; i < feeTiers.length; i++) {
            require(feeTiers[i] > 0, "bad fee tier");
            commonFeeTiers.push(feeTiers[i]);
        }
        emit CommonFeeTiersSet(feeTiers);
    }

    function getCommonFeeTiers() external view returns (uint24[] memory) {
        return commonFeeTiers;
    }

    function setIntermediateTokens(address[] calldata tokens) external onlyOwner {
        delete intermediateTokens;
        for (uint256 i = 0; i < tokens.length; i++) {
            require(tokens[i] != address(0), "intermediate is zero");
            intermediateTokens.push(tokens[i]);
        }
        emit IntermediateTokensSet(tokens);
    }

    function getIntermediateTokens() external view returns (address[] memory) {
        return intermediateTokens;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "new owner is zero");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
    }

    function withdrawToken(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "to is zero");
        _safeTransfer(token, to, amount);
    }

    function _resolveSwapPath(address tokenIn, address tokenOut) internal view returns (bytes memory) {
        uint24 directFee = _findFeeTier(tokenIn, tokenOut);
        if (directFee != 0) {
            return abi.encodePacked(tokenIn, directFee, tokenOut);
        }

        for (uint256 i = 0; i < intermediateTokens.length; i++) {
            address intermediate = intermediateTokens[i];
            if (intermediate == tokenIn || intermediate == tokenOut) {
                continue;
            }

            uint24 firstFee = _findFeeTier(tokenIn, intermediate);
            if (firstFee == 0) {
                continue;
            }

            uint24 secondFee = _findFeeTier(intermediate, tokenOut);
            if (secondFee == 0) {
                continue;
            }

            return abi.encodePacked(tokenIn, firstFee, intermediate, secondFee, tokenOut);
        }

        revert("no v3 path");
    }

    function _findFeeTier(address tokenIn, address tokenOut) internal view returns (uint24) {
        uint24 preferred = preferredFeeTier[tokenIn][tokenOut];
        if (preferred != 0) {
            return preferred;
        }

        address factory = netSwapRouter.factory();
        for (uint256 i = 0; i < commonFeeTiers.length; i++) {
            uint24 fee = commonFeeTiers[i];
            if (IUniswapV3FactoryMinimal(factory).getPool(tokenIn, tokenOut, fee) != address(0)) {
                return fee;
            }
        }

        return 0;
    }

    function _safeApprove(address token, address spender, uint256 amount) internal {
        if (amount == 0) {
            return;
        }

        _callOptionalReturn(token, abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, 0));
        _callOptionalReturn(token, abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
    }

    function _callOptionalReturn(address token, bytes memory data) internal {
        (bool ok, bytes memory returndata) = token.call(data);
        require(ok, "token call failed");
        if (returndata.length > 0) {
            require(abi.decode(returndata, (bool)), "token operation failed");
        }
    }
}
