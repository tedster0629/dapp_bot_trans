pragma solidity ^0.4.16; /// @title Shipment-related Smart contract contract Shipment {
    
    address public sender;
    address public receiver;
    address public handler;
    
    uint256 public value;
    bytes32 public name;
    
    enum Status {Shipped, Completed, Refused} Status status;
    
    //bool public payOnDestination;
    //uint public shipmentDeadLine;
    
    modifier onlyIfActive() { require(status == Status.Shipped); _; }
    modifier onlyIfPaid() { require(msg.value == value); _; }
    //modifier onlyBeforeTime(uint _time) { require(now < _time); _; }
    //modifier onlyAfterTime(uint _time) { require(now > _time); _; }
    
    event Shipped();
    event Completed();
    event Refused();
    
    function Shipment(address receiverAddress, address handlerAddress, uint64 shipmentGivenPrice, bytes32 
shipmentGivenName) public {
    //function Shipment(address receiverAddress, address handlerAddress, uint64 shipmentGivenPrice, bool 
toPayOnDestination) public {
        sender = tx.origin;
        receiver = receiverAddress;
        handler = handlerAddress;
        value = shipmentGivenPrice;
        name = shipmentGivenName;
        //payOnDestination = toPayOnDestination;
        
        status = Status.Shipped;
        Shipped();
    }
    
    function setStatusCompleted() public onlyIfActive onlyIfPaid {
        status = Status.Completed;
        Completed();
    }
    
    function setStatusRefused() public onlyIfActive {
        status = Status.Refused;
        Refused();
    }
    
    function getStatus() public constant returns(Status){
        return status;
    }
    
}
contract shipmentManager {
    
    struct shipmentListing {
        bytes32 name;
        Shipment.Status status;
    }
    
    bytes32[] allNames
    
    mapping(uint64 => Shipment) allContracts;
    mapping(bytes32 => uint64) allNames;
    mapping(address => uint64[]) public shippedContracts;
    mapping(address => uint64[]) public incomingContracts;
    mapping(address => uint64[]) public handledContracts;
    
    uint64 public numAllContracts;
    mapping(address => uint32) public numShippedContracts;
    mapping(address => uint32) public numIncomingContracts;
    mapping(address => uint32) public numHandledContracts;
    
    mapping (address => uint) pendingWithdrawals;
    
    function shipmentManager() public {
        numAllContracts = 1;
    }
    
    function listShipped() public returns(shipmentListing[]) {
        shipmentListing[] memory shippedContractListing = new 
shipmentListing[](numShippedContracts[msg.sender]);
        for(uint32 i=0;i<numShippedContracts[msg.sender];i++){
            Shipment aux_contract = allContracts[shippedContracts[msg.sender][i]];
            shipmentListing memory aux_listing = shipmentListing({
                name: aux_contract.name(),
                status: aux_contract.getStatus()
                
            });
            shippedContractListing[i] = aux_listing;
        }
        return shippedContractListing;
    }
    
    function listIncoming() public returns(shipmentListing[]) {
        shipmentListing[] memory incomingContractListing = new 
shipmentListing[](numIncomingContracts[msg.sender]);
        for(uint32 i=0;i<numIncomingContracts[msg.sender];i++){
            Shipment aux_contract = allContracts[incomingContracts[msg.sender][i]];
            shipmentListing memory aux_listing = shipmentListing({
                name: aux_contract.name(),
                status: aux_contract.getStatus()
                
            });
            incomingContractListing[i] = aux_listing;
        }
        return incomingContractListing;
    }
    
    function listHandled() public returns(shipmentListing[]) {
        shipmentListing[] memory handledContractListing = new 
shipmentListing[](numHandledContracts[msg.sender]);
        for(uint32 i=0;i<numHandledContracts[msg.sender];i++){
            Shipment aux_contract = allContracts[handledContracts[msg.sender][i]];
            shipmentListing memory aux_listing = shipmentListing({
                name: aux_contract.name(),
                status: aux_contract.getStatus()
                
            });
            handledContractListing[i] = aux_listing;
        }
        return handledContractListing;
    }
    
    function deployShipmentContract(address receiverAddress, address handlerAddress, uint64 shipmentGivenPrice, 
bytes32 shipmentGivenName) public returns(bool){
        
        require(allNames[shipmentGivenName] > 0);
        
        uint64 numAllContracts_ = numAllContracts;
        uint64 numShippedContracts_ = numShippedContracts[msg.sender];
        uint64 numHandledContracts_ = numHandledContracts[handlerAddress];
        uint64 numIncomingContracts_ = numIncomingContracts[receiverAddress];
        
        numAllContracts += 1;
        numShippedContracts[msg.sender] += 1;
        numHandledContracts[handlerAddress] += 1;
        numIncomingContracts[receiverAddress] += 1;
        
        allContracts[numAllContracts_] = new Shipment(receiverAddress, handlerAddress, shipmentGivenPrice, 
shipmentGivenName);
        shippedContracts[msg.sender][numShippedContracts_] = numAllContracts_;
        handledContracts[handlerAddress][numHandledContracts_] = numAllContracts_;
        incomingContracts[receiverAddress][numIncomingContracts_] = numAllContracts_;
        
        return true;
    }
    
    function receivedAndAccepted(bytes32 shipmentGivenName) public payable {
        
        uint64 contractId = allNames[shipmentGivenName];
        bool found = false;
        
        for(uint32 i=0; i<numIncomingContracts[msg.sender]; i++){
            if(incomingContracts[msg.sender][i] == contractId){
                found = true;
                break;
            }
        }
        
        require(found);
        require(allContracts[contractId].value() == msg.value);
        
        allContracts[contractId].setStatusCompleted();
        pendingWithdrawals[allContracts[contractId].sender()] += msg.value;
        
    }
    
    function receivedAndRefused(bytes32 shipmentGivenName) public {
        
        uint64 contractId = allNames[shipmentGivenName];
        bool found = false;
        
        for(uint32 i=0; i<numIncomingContracts[msg.sender]; i++){
            if(incomingContracts[msg.sender][i] == contractId){
                found = true;
                break;
            }
        }
        
        require(found);
        
        allContracts[contractId].setStatusRefused();
        
    }
    
    function withdraw() public {
        uint amount = pendingWithdrawals[msg.sender];
        pendingWithdrawals[msg.sender] = 0;
        msg.sender.transfer(amount);
    }
}
